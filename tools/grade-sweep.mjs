#!/usr/bin/env node
// Off-repo grade sweep (proof of concept).
//
// For each assignment in grader/assignments.json, finds the matching student
// repos for a section, clones each, grades it against the CANONICAL tests/keys
// kept here in the teacher repo (so a student editing their own tests changes
// nothing), records the score in gradebook/ (delivery to student repos
// is publish-grades.mjs only). Idempotent: a repo whose latest commit is
// already graded is skipped unless --force.
//
// Usage: node tools/grade-sweep.mjs <section> [--force] [--only=<assignmentId>]
//
// Auth: uses your local `gh`/`git` credentials (run from a machine logged in
// with access to the repos). The GitHub Actions version wraps this same script.

import { execSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { runNotesPass } from "./lib/ai-feedback.mjs";

const pExecFile = promisify(execFile);

const section = process.argv[2];
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : null;
const repoArg = process.argv.find((a) => a.startsWith("--repo="));
const onlyRepo = repoArg ? repoArg.split("=")[1] : null; // grade just this one repo
if (!section) {
  console.error("usage: grade-sweep.mjs <section> [--force] [--dry-run] [--only=<id>] [--repo=<name>] [--jobs=<n>]");
  process.exit(1);
}

// Every child command gets a 10-minute ceiling: one pathological repo (an
// infinite loop hit while tests load, a wedged npm/dart fetch) must fail and
// score 0, not stall execSync until the runner's 6-hour kill eats the sweep.
const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, ...opts }).trim();

// Async twins of the helper above, used only inside the per-repo grading path
// so several repos can be in flight at once. execSync blocks the event loop, so
// nothing can overlap while it runs; these do not. Same 10-minute ceiling, and
// the rejection carries .stdout/.signal exactly like the execSync error the
// callers already handle.
const shA = async (cmd, opts = {}) =>
  (await pExecFile("/bin/sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...opts })).stdout.trim();
const quietA = async (cmd, opts = {}) => {
  await pExecFile("/bin/sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...opts });
};

// How many repos to clone + test at once. Billed Actions minutes are wall
// clock, so overlapping the per-repo work cuts the bill directly. Capped at 4
// because the clones are also GitHub API traffic and a bigger fan-out risks a
// secondary rate limit for a shrinking return.
const jobsArg = process.argv.find((a) => a.startsWith("--jobs="));
const JOBS = Math.max(1, Number(jobsArg?.split("=")[1]) ||
  Math.min(4, availableParallelism()));

// Bounded worker pool. `onOrdered` fires per item, in ITEM order, as soon as
// every earlier item has finished, which is what keeps the gradebook and the
// run log byte-identical to a serial sweep no matter how the tasks interleave.
// Streaming the completed prefix (rather than printing at the end) also keeps a
// long sweep readable live, and stops a job that hits its timeout-minutes
// ceiling from taking the whole log down with it.
async function pool(items, limit, fn, onOrdered) {
  const out = new Array(items.length);
  const ready = new Array(items.length).fill(false);
  let next = 0, flushed = 0;
  const drain = () => {
    while (flushed < items.length && ready[flushed]) {
      onOrdered?.(out[flushed], flushed);
      flushed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      ready[i] = true;
      drain();
    }
  }));
  drain();
  return out;
}

// In Actions, set GRADE_OWNER to the org (github.repository_owner); locally it
// falls back to the authenticated gh user.
const OWNER = process.env.GRADE_OWNER || sh("gh api user -q .login");
// Keep the UNFILTERED policy around: the unmatched-submissions report at the end
// has to know every activity this section runs, not just the one --only selected,
// or a targeted run reports every other activity's submissions as orphans.
const allAssignments = JSON.parse(readFileSync("grader/assignments.json", "utf8"));
const assignments = allAssignments.filter((a) => !only || a.id === only);

const WORK = ".grade-work";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ---- CSV helpers ---------------------------------------------------------
const HEADER =
  "repo,githubAccount,fullName,studentNumber,studentEmail,classCode,assignment,sha,passed,total,score,gradedAt,late,notes,aiScore,failures";
// Notes are markdown (commas + newlines) and failures is a JSON array, so both
// are stored base64 in the CSV to stay on one field/line; the rest is plain.
const encNotes = (s) => (s ? Buffer.from(String(s), "utf8").toString("base64") : "");
const decNotes = (s) => { try { return s ? Buffer.from(s, "base64").toString("utf8") : ""; } catch { return ""; } };
const encFails = (a) => (a && a.length ? Buffer.from(JSON.stringify(a), "utf8").toString("base64") : "");
const decFails = (s) => { try { return s ? JSON.parse(Buffer.from(s, "base64").toString("utf8")) : []; } catch { return []; } };
const csvField = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // quote only when needed
};
const parseCsvLine = (line) => {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};

// ---- gradebook (source of truth) ----------------------------------------
const CSV = "gradebook/grades.csv";
const rows = [];
const seen = new Map(); // `${repo}|${assignment}` -> graded sha
const gradedThisRun = new Set(); // `${repo}|${assignment}` actually (re)graded now -> AI feedback gate
if (existsSync(CSV)) {
  const lines = readFileSync(CSV, "utf8").trim().split("\n");
  if (lines[0] === HEADER) { // ignore an old/foreign format and start fresh
    for (const ln of lines.slice(1).filter(Boolean)) {
      const f = parseCsvLine(ln);
      const row = {
        repo: f[0], githubAccount: f[1], fullName: f[2], studentNumber: f[3],
        studentEmail: f[4], classCode: f[5], assignment: f[6], sha: f[7],
        passed: +f[8], total: +f[9], score: f[10], gradedAt: f[11],
        late: f[12] === "true", notes: decNotes(f[13]),
        aiScore: f[14] === "" || f[14] == null ? null : +f[14],
        failures: decFails(f[15]),
      };
      rows.push(row);
      seen.set(`${row.repo}|${row.assignment}`, row.sha);
    }
  }
}

// ---- helpers -------------------------------------------------------------
// One org listing serves the whole sweep. `gh repo list` pages through every
// repo in the org (thousands), so calling it once per activity re-fetched the
// same listing 20+ times a run for nothing.
// A big org's repo listing is a GraphQL query, and it fails: a 504 on the 2026-08-11
// publish and a 503 on the 2026-08-17 sweep, both mid-run. Without a retry the whole
// sweep dies on one transient answer and grades nobody, so this mirrors the retry
// publish-grades.mjs already carries. An empty listing is refused rather than cached:
// `allReposCache ??=` would pin `[]` for the rest of the run, and every activity would
// then resolve zero submissions and report a clean sweep that graded no one.
let allReposCache = null;
const allRepos = () => {
  if (allReposCache) return allReposCache;
  let names = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      names = JSON.parse(sh(`gh repo list ${OWNER} --limit 5000 --json name`)) // limit > org repo count, else repos get silently dropped
        .map((r) => r.name);
    } catch (e) {
      console.error(`attempt ${attempt}: listing ${OWNER} failed (${e.message.split("\n")[0]})`);
    }
    if (names.length) break;
    if (attempt < 3) { console.error(`attempt ${attempt}: no repos resolved, retrying`); sh("sleep 20"); }
  }
  if (!names.length) {
    console.error(`Listing ${OWNER} returned no repos after 3 attempts. Refusing to report a clean sweep that graded nobody.`);
    process.exit(1);
  }
  console.log(`Resolved ${names.length} repos in ${OWNER}.`);
  return (allReposCache = names);
};
// Repo names drift in ways that silently cost a student their whole grade,
// because nothing else in the platform name-checks a SUBMISSION repo
// (audit-repo-names.mjs only looks at student-/teacher-). Two drifts are
// unambiguous and are normalized here rather than left ungraded forever:
// underscores in place of hyphens (`m4a2_0000_DelaCruz`) and the student's handle
// prepended (`jdelacruz-m5a3-0000-jdelacruz`). The SECTION token still has to match
// exactly - guessing a section would file a grade under the wrong class, which
// is worse than not grading it. Everything unclaimed lands in UNMATCHED.md.
const canon = (n) => n.toLowerCase().replace(/_/g, "-");
// Never treat an infrastructure repo as a submission. This matters because the
// handle-strip rule below would otherwise claim things like
// `teacher-<org>-<section>-prelim-grading-backfill` as a `prelim-` submission
// and try to grade the teacher repo.
const INFRA = /^(student|teacher)-|-solution$|yourname|classcode|live-demo/;
const matchesActivity = (name, prefix) => {
  const c = canon(name), p = prefix.toLowerCase();
  if (INFRA.test(c)) return false;
  if (c.startsWith(p)) return true;
  const at = c.indexOf(`-${p}`);          // "<handle>-m5a3-0000-..."
  return at > 0 && /^[a-z0-9.-]+$/.test(c.slice(0, at));
};
const inSection = (name) => canon(name).includes(`-${String(section).toLowerCase()}-`);
const listRepos = (prefix) =>
  allRepos()
    .filter((n) => matchesActivity(n, prefix) && inSection(n))
    .filter((n) => !onlyRepo || n === onlyRepo);

// Cheap pre-clone triage. Cloning is the sweep's dominant cost: on a settled
// section almost every repo is locked-and-already-graded, so the sweep paid
// ~2s to clone each one and then graded nothing (the 2026-07-26 ADET run spent
// 23 of its 28 minutes that way). GraphQL returns the only two things the skip
// decisions need - the branch head and student.json - for 40 repos per request,
// so we clone only what we are actually going to grade.
// Strictly best-effort: any repo missing from the result falls through to the
// original clone-first path, so an API hiccup costs speed, never accuracy.
function peekRepos(repos) {
  const out = new Map();
  const field = (n, j) =>
    `r${j}: repository(owner:${JSON.stringify(OWNER)},name:${JSON.stringify(n)})` +
    `{defaultBranchRef{target{oid}} object(expression:"HEAD:student.json"){... on Blob{text}}}`;
  const fetch = (slice) => {
    const qf = `${WORK}/.peek.gql`;
    writeFileSync(qf, `query{${slice.map(field).join("\n")}}`);
    let raw;
    try {
      raw = sh(`gh api graphql -F query=@${qf}`, { maxBuffer: 1e8 });
    } catch (e) {
      // A deleted repo makes gh exit non-zero while still returning data for
      // the rest of the batch, so use stdout when there is any.
      raw = (e.stdout || "").toString().trim();
      if (!raw) return false;
    }
    let data;
    try { data = JSON.parse(raw).data; } catch { return false; }
    if (!data) return false;
    slice.forEach((n, j) => {
      const r = data[`r${j}`];
      if (!r) return; // deleted/unreadable -> clone-first path
      out.set(n, { head: r.defaultBranchRef?.target?.oid || null, student: r.object?.text ?? null });
    });
    return true;
  };
  const BATCH = 40; // 100 aliases overruns the GraphQL timeout; 40 is comfortable
  for (let i = 0; i < repos.length; i += BATCH) {
    const slice = repos.slice(i, i + BATCH);
    if (fetch(slice)) continue;
    // One retry in halves before giving up on this slice (it then clones).
    const mid = Math.ceil(slice.length / 2);
    fetch(slice.slice(0, mid));
    fetch(slice.slice(mid));
  }
  return out;
}

// Fingerprint of an activity's canonical tests. The skip decisions above trust
// the stored gradebook row, which is only sound while grader/<id>/ is
// unchanged; this notices an edited/fixed canonical test instead of silently
// reusing a grade computed against the old one.
const GRADER_HASHES = "gradebook/grader-hashes.json";
// RUBRIC.md is deliberately excluded from this fingerprint. It is guidance for
// the reviewed half, not a canonical test, so editing it must never mark an
// activity stale: a re-graded row is rebuilt with aiScore null and notes "",
// which would silently throw away every reviewed score the activity holds.
// Rubric drift is fingerprinted separately by rubricHash and only reported.
const RUBRIC_FILE = "RUBRIC.md";
const graderHash = (id) => {
  const root = `grader/${id}`;
  if (!existsSync(root)) return "";
  const h = createHash("sha1");
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${d}/${e.name}`, r);
      else if (e.name !== RUBRIC_FILE) { h.update(r); h.update(readFileSync(`${d}/${e.name}`)); }
    }
  };
  try { walk(root, ""); } catch { return ""; }
  return h.digest("hex").slice(0, 12);
};
const rubricHash = (id) => {
  const p = `grader/${id}/${RUBRIC_FILE}`;
  if (!existsSync(p)) return "";
  return createHash("sha1").update(readFileSync(p)).digest("hex").slice(0, 12);
};

// The graders run inside the worker pool, so they never print directly:
// interleaved output from four repos at once would be unreadable and would make
// the run log depend on timing. They append to the caller's `log` buffer, which
// the sweep flushes in repo order.
async function gradeVitest(dir, id, log) {
  cpSync(`grader/${id}`, dir, { recursive: true }); // overlay canonical tests
  try {
    await quietA("npm install --no-audit --no-fund --silent", { cwd: dir });
  } catch {
    // No/broken package.json (e.g. a repo made from the wrong template) -> it
    // can't build, so it earns 0 rather than aborting the whole sweep.
    return { passed: 0, total: 0, malformed: true };
  }
  try {
    await quietA("npx vitest run --reporter=json --outputFile=.vit.json", { cwd: dir });
  } catch (e) {
    /* tests failing -> non-zero exit is expected; results still written */
    if (e.signal) log.push(`  TIMEOUT: vitest killed after 10min (hung student code?)`);
  }
  const out = `${dir}/.vit.json`;
  if (!existsSync(out)) return { passed: 0, total: 0 };
  const r = JSON.parse(readFileSync(out, "utf8"));
  // The same report carries each test's title; keep the failed ones (titles
  // only) so AI feedback can explain the real failures. In memory only.
  const failures = [];
  for (const f of r.testResults ?? []) {
    for (const t of f.assertionResults ?? []) {
      if (t.status !== "passed") failures.push({ title: t.fullName || t.title || "(unnamed check)" });
    }
  }
  return { passed: r.numPassedTests ?? 0, total: r.numTotalTests ?? 0, failures };
}

async function gradeDart(dir, id, log) {
  cpSync(`grader/${id}`, dir, { recursive: true }); // overlay canonical tests
  try {
    await quietA("dart pub get", { cwd: dir });
  } catch {
    // No/broken pubspec (e.g. a repo made from the wrong template) -> it can't
    // build, so it earns 0 rather than aborting the whole sweep.
    return { passed: 0, total: 0, malformed: true };
  }
  let out = "";
  try {
    out = await shA("dart test --reporter json", { cwd: dir });
  } catch (e) {
    out = (e.stdout || "").toString(); // tests failing -> non-zero exit; stdout still has the json events
    if (e.signal) log.push(`  TIMEOUT: dart test killed after 10min (hung student code?)`);
  }
  let passed = 0, total = 0;
  const names = new Map(); // testID -> name (from testStart events)
  const failures = [];
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (e.type === "testStart" && e.test) names.set(e.test.id, e.test.name);
    if (e.type === "testDone" && e.hidden !== true) {
      total++;
      if (e.result === "success") passed++;
      else failures.push({ title: names.get(e.testID) || "(unnamed check)" });
    }
  }
  return { passed, total, failures };
}

function gradeQuiz(dir, keyPath) {
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  const ansPath = `${dir}/answers.json`;
  const ans = existsSync(ansPath) ? JSON.parse(readFileSync(ansPath, "utf8")) : {};
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const qs = Object.keys(key);
  const passed = qs.filter((q) => norm(ans[q]) === norm(key[q])).length;
  return { passed, total: qs.length };
}

// A student's identity from the text of their student.json (same file whether
// it came from a clone or from the pre-clone peek).
function parseStudent(text) {
  try {
    const s = JSON.parse(text);
    return {
      githubAccount: s.githubAccount || "",
      fullName: s.fullName || "",
      studentNumber: s.studentNumber || "",
      studentEmail: s.studentEmail || "",
      classCode: s.classCode || "",
    };
  } catch {
    return { githubAccount: "", fullName: "", studentNumber: "", studentEmail: "", classCode: "" };
  }
}

// Read a student's identity from their student.json (if present in the clone).
function readStudent(dir) {
  try { return parseStudent(readFileSync(`${dir}/student.json`, "utf8")); }
  catch { return parseStudent(null); }
}

// ---- canonical-test drift ------------------------------------------------
// Compare each activity's grader/ fingerprint with the one recorded at the last
// sweep. Unlocked activities whose tests changed re-grade this run; locked ones
// stay frozen (a delivered grade must not move on its own) and are reported.
// Rubric drift is tracked apart from test drift, under the reserved _rubrics
// key, and only ever reported: a rubric edit must not cost a reviewed score.
const prevHashes = existsSync(GRADER_HASHES)
  ? (() => { try { return JSON.parse(readFileSync(GRADER_HASHES, "utf8")); } catch { return {}; } })()
  : {};
const prevRubrics = prevHashes._rubrics && typeof prevHashes._rubrics === "object" ? prevHashes._rubrics : {};
const curHashes = { ...prevHashes };
const curRubrics = { ...prevRubrics };
const staleGrader = new Set();
const staleRubric = new Set();
for (const a of assignments) {
  if (!a.namePrefix) continue;
  const rh = rubricHash(a.id);
  if (rh) {
    curRubrics[a.id] = rh;
    if (prevRubrics[a.id] && prevRubrics[a.id] !== rh) staleRubric.add(a.id);
  }
  const h = graderHash(a.id);
  if (!h) continue;
  curHashes[a.id] = h;
  if (prevHashes[a.id] && prevHashes[a.id] !== h) staleGrader.add(a.id);
}
curHashes._rubrics = curRubrics;
for (const id of staleGrader) {
  const locked = assignments.find((a) => a.id === id)?.locked;
  console.log(locked
    ? `NOTE  grader/${id}/ changed since the last sweep - grades stay frozen (locked); re-grade with --force --only=${id}`
    : `NOTE  grader/${id}/ changed since the last sweep - re-grading ${id}`);
}
for (const id of staleRubric) {
  console.log(`NOTE  grader/${id}/RUBRIC.md changed since the last sweep - grades unchanged; re-review ${id} if the criteria moved`);
}

// ---- sweep ---------------------------------------------------------------
console.log(`grading with ${JOBS} parallel job(s)`);

// Framework exceptions seen while grading, per activity: text -> repos that hit
// it. One student's crash is their own bug; the SAME text across several
// submissions is the toolchain changing under the course, which is what makes
// it worth a tripwire. Filled from the ordered callback, so the record is
// deterministic no matter how the parallel jobs interleave.
const advisorySeen = new Map(); // assignment id -> Map(text -> Set(repo))


// Clone + test one submission. Runs inside the worker pool, so it must touch
// nothing shared: it reads `rows`/`seen` (never written during the pool) and
// writes only its own .grade-work/<repo>. Everything it wants to change in the
// gradebook comes back as data and is applied serially, in repo order, below.
async function gradeOne(a, repo, stale) {
  const dir = `${WORK}/${repo}`;
  const log = [];
  const done = (extra) => ({ log, ...extra });
  // A clone can fail transiently (network / secondary rate limit) or for a
  // genuinely broken repo. Don't let one bad clone abort the whole sweep -
  // skip it this run (it gets picked up next time), with one quick retry.
  try { await quietA(`gh repo clone ${OWNER}/${repo} ${dir} -- -q --depth=1`); }
  catch {
    try { await quietA(`gh repo clone ${OWNER}/${repo} ${dir} -- -q --depth=1`); }
    catch { log.push(`skip  ${repo} (${a.id}) - clone failed (transient or broken); will retry next run`); return done(); }
  }
  // Submission sha = latest commit touching anything other than the receipt
  // files, so our own receipt commits never make the next run re-grade.
  // An empty repo (made from the template but never pushed) has no
  // commits, so `git log`/`git rev-parse` aborts and would crash the whole
  // sweep. It is not a submission, so skip it.
  try { await shA(`git -C ${dir} rev-parse HEAD`); }
  catch { log.push(`empty ${repo} (${a.id}) - no commits yet, skipping`); return done(); }
  const sha =
    await shA(`git -C ${dir} log -1 --format=%H -- . ':!grades' ':!GRADES.md'`) ||
    await shA(`git -C ${dir} rev-parse HEAD`);
  const stu = readStudent(dir);
  const alreadyGraded = seen.has(`${repo}|${a.id}`);
  // LOCKED assignment: a grade already recorded is frozen (re-submissions are
  // ignored). A student not yet graded can still be graded, but flagged late.
  if (a.locked && alreadyGraded) {
    log.push(`lock  ${repo} (${a.id}) - frozen (locked, already graded)`);
    return done({ freshen: stu });
  }
  // UNLOCKED: skip if unchanged since last grade (unless --force, or the
  // canonical tests changed since that grade was computed).
  if (!a.locked && !force && !stale && seen.get(`${repo}|${a.id}`) === sha) {
    log.push(`skip  ${repo} (${a.id}) - already graded @ ${sha.slice(0, 7)}`);
    return done({ freshen: stu }); // keep roster info fresh even when skipping
  }
  const res =
    a.type === "quiz" ? gradeQuiz(dir, a.key)
    : a.type === "dart" ? await gradeDart(dir, a.id, log)
    : await gradeVitest(dir, a.id, log);
  const score = res.total ? `${res.passed}/${res.total}` : "0/0";
  const late = !!a.locked && !alreadyGraded; // first grade on a locked activity = late
  const row = { repo, ...stu, assignment: a.id, sha, passed: res.passed, total: res.total, score, late, gradedAt: new Date().toISOString(), notes: "", aiScore: null, failures: res.failures || [] };
  const flags = `${late ? " LATE" : ""}${res.malformed ? " MALFORMED(wrong-template?)" : ""}`;
  log.push(`${dryRun ? "[dry-run] " : ""}grade ${repo} (${a.id}): ${score}${flags}`);
  // Free the runner disk as we go: per-repo node_modules/.dart_tool add up
  // to "No space left on device" over a big section (the 07-08 2125 sweep
  // died that way). Source clones stay - previews/AI notes read them later.
  // With JOBS repos in flight this matters more, not less.
  rmSync(`${dir}/node_modules`, { recursive: true, force: true });
  rmSync(`${dir}/.dart_tool`, { recursive: true, force: true });
  return done({ row, sha });
}

for (const a of assignments) {
  // Manual / badge activities (manual:true, submit:"url"|"canvas") have no
  // namePrefix and no submission repos - they are graded in Canvas SpeedGrader.
  // Skip them so listRepos doesn't crash on an undefined prefix.
  if (!a.namePrefix) continue;
  const repos = listRepos(a.namePrefix);
  const peeked = peekRepos(repos);
  const stale = staleGrader.has(a.id);
  // Pass 1, serial and cheap: decide what we can without cloning. Every branch
  // here reaches the same verdict the post-clone checks would: a frozen locked
  // grade ignores the sha entirely, and an unlocked skip needs the stored sha
  // to BE the branch head (anything else falls through to the clone and is
  // re-checked against the path-filtered sha, exactly as before).
  const todo = [];
  for (const repo of repos) {
    const pre = peeked.get(repo);
    if (pre) {
      if (!pre.head) { console.log(`empty ${repo} (${a.id}) - no commits yet, skipping`); continue; }
      const key = `${repo}|${a.id}`;
      const freshen = () => {
        const ex = rows.find((r) => r.repo === repo && r.assignment === a.id);
        if (ex) Object.assign(ex, parseStudent(pre.student));
      };
      if (a.locked && seen.has(key)) {
        freshen();
        console.log(`lock  ${repo} (${a.id}) - frozen (locked, already graded)`);
        continue;
      }
      if (!a.locked && !force && !stale && seen.get(key) === pre.head) {
        freshen(); // keep roster info fresh even when skipping
        console.log(`skip  ${repo} (${a.id}) - already graded @ ${pre.head.slice(0, 7)}`);
        continue;
      }
    }
    todo.push(repo);
  }
  // Pass 2, parallel: clone + test whatever survived the triage. The gradebook
  // is applied from the pool's ORDERED callback rather than inside the tasks,
  // which is what makes a parallel sweep produce byte-identical output to a
  // serial one no matter how the work interleaves.
  await pool(todo, JOBS, (repo) => gradeOne(a, repo, stale), (res, i) => {
    const repo = todo[i];
    for (const ln of res.log) console.log(ln);
    if (res.freshen) {
      const ex = rows.find((r) => r.repo === repo && r.assignment === a.id);
      if (ex) Object.assign(ex, res.freshen);
    }
    if (!res.row) return;
    const idx = rows.findIndex((r) => r.repo === repo && r.assignment === a.id);
    if (idx >= 0) rows[idx] = res.row; else rows.push(res.row);
    seen.set(`${repo}|${a.id}`, res.sha);
    gradedThisRun.add(`${repo}|${a.id}`); // genuinely (re)graded now -> eligible for AI notes
    for (const t of res.advisories || []) {
      if (!advisorySeen.has(a.id)) advisorySeen.set(a.id, new Map());
      const m = advisorySeen.get(a.id);
      if (!m.has(t)) m.set(t, new Set());
      m.get(t).add(repo);
    }
  });
}

// ---- AI feedback notes (after grading; best-effort) ----------------------
await runNotesPass(rows, assignments, gradedThisRun, { work: WORK });

// ---- anomaly tripwires ---------------------------------------------------
// Two shapes that read as a student failing but are usually the toolchain. They
// never change a grade; they are printed and written to gradebook/ANOMALIES.md
// so the operator sees them before grades go out.
//
//   1. A test TOTAL that differs from the rest of the class. Everyone is graded
//      against the SAME canonical tests, so a different count means the suite
//      did not fully run: a compile error, or a single thrown exception killing
//      every test in its file. Flutter 3.44's ListTile styling advisory did
//      exactly that and cost three students six marks each before anyone
//      noticed (see test/support/style_advisories.dart).
//   2. The same framework exception in two or more submissions. See
//      advisorySeen above.
const anomalies = [];
for (const a of assignments) {
  if (!a.namePrefix) continue; // manual / Canvas-graded: no test count to compare
  const mine = rows.filter((r) => r.assignment === a.id);
  const scored = mine.filter((r) => r.total > 0);
  if (scored.length < 5) continue; // too few submissions to know what normal is
  const counts = new Map();
  for (const r of scored) counts.set(r.total, (counts.get(r.total) || 0) + 1);
  // Most common total wins; ties break on the HIGHER total, which is the more
  // complete run. A total can land either side of the mode: BELOW means part of
  // the suite never ran, ABOVE means the student wrote tests of their own and
  // they are being counted in the denominator.
  const mode = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
  const odd = mine.filter((r) => r.total !== mode).sort((x, y) => x.repo.localeCompare(y.repo));
  if (odd.length) {
    anomalies.push(
      `### ${a.id}: ${odd.length} submission(s) ran a different number of tests`, "",
      `The class runs **${mode}** tests for this activity. These did not, so their score is measured against a different denominator. Check each one before the grade is delivered.`, "",
      "| Repo | Score | Reading |", "| --- | --- | --- |",
      ...odd.map((r) => `| \`${r.repo}\` | ${r.passed}/${r.total} | ${
        r.total === 0 ? "did not build at all (compile error, or made from the wrong template)"
        : r.total < mode ? "part of the suite never ran (one thrown exception kills every test in its file)"
        : "counts tests the student wrote themselves, so the denominator is not the class's"} |`),
      "",
    );
  }
  const shared = [...(advisorySeen.get(a.id) || new Map())]
    .filter(([, repos]) => repos.size >= 2)
    .sort((x, y) => y[1].size - x[1].size);
  if (shared.length) {
    anomalies.push(
      `### ${a.id}: ${shared.length} framework exception(s) hit more than one submission`, "",
      "The same exception across several students points at the toolchain, not at them. If it is cosmetic advice rather than a real fault, add it to `test/support/style_advisories.dart` (and re-grade); if it is real, it belongs in the activity brief.", "",
      "| Submissions | Exception |", "| --- | --- |",
      ...shared.map(([text, repos]) => `| ${repos.size} | ${text.replace(/\|/g, "\\|")} |`),
      "",
    );
  }
}
mkdirSync("gradebook", { recursive: true });
writeFileSync("gradebook/ANOMALIES.md", [
  `# Grading anomalies - section ${section}`, "",
  anomalies.length
    ? "Things that look like a student failing but are usually the toolchain. Nothing here changed a grade."
    : "Nothing anomalous. Every submission ran the same number of tests as its class, and no framework exception hit more than one student.",
  "", ...anomalies,
].join("\n") + "\n");
if (anomalies.length) console.log(`\nANOMALIES: see gradebook/ANOMALIES.md before delivering these grades`);

// ---- write gradebook -----------------------------------------------------
mkdirSync("gradebook", { recursive: true });
// Fingerprints of the canonical tests these grades were computed against, so
// the next sweep can tell "unchanged, safe to reuse" from "test was edited".
writeFileSync(GRADER_HASHES, JSON.stringify(curHashes, null, 2) + "\n");
writeFileSync(
  CSV,
  HEADER + "\n" +
    rows.map((r) =>
      [
        r.repo, r.githubAccount, r.fullName, r.studentNumber, r.studentEmail,
        r.classCode, r.assignment, r.sha, r.passed, r.total, r.score, r.gradedAt,
        r.late ? "true" : "", encNotes(r.notes), r.aiScore ?? "", encFails(r.failures),
      ].map(csvField).join(",")
    ).join("\n") + "\n",
);
// Teacher copy of each fresh note (with instructor-only triage flags). Written
// only for rows regenerated this run; prior notes stay committed on disk.
const notePath = (r) => `gradebook/notes/${r.assignment}/${r.repo}.md`;
for (const r of rows) {
  if (!r.notesInstructor) continue;
  mkdirSync(`gradebook/notes/${r.assignment}`, { recursive: true });
  writeFileSync(notePath(r), `# ${r.repo} - ${r.assignment} (${r.score})\n\n_AI draft for the subjective rubric. Review before grading._\n\n${r.notesInstructor}\n`);
}
const hasNote = (r) => existsSync(notePath(r));
const totalPtsOf = new Map(assignments.map((a) => [a.id, a.totalPoints]));
// "Feedback" column shows the AI's proposed total grade (out of the activity's
// points, when it returned one) linked to the full note, for at-a-glance review.
const fbCell = (r) => {
  if (!hasNote(r)) return "";
  const pts = totalPtsOf.get(r.assignment);
  const label = r.aiScore != null ? `${r.aiScore}/${pts || 100}` : "notes";
  return `[${label}](notes/${r.assignment}/${r.repo}.md)`;
};
const md = [
  `# Gradebook - section ${section}`,
  "",
  "| Student | Number | GitHub | Assignment | Grade | Feedback | Late | Commit | Graded |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) =>
    `| ${r.fullName || "?"} | ${r.studentNumber || "?"} | ${r.githubAccount || r.repo} | ${r.assignment} | ${r.score} | ${fbCell(r)} | ${r.late ? "LATE" : ""} | \`${r.sha.slice(0, 7)}\` | ${r.gradedAt.slice(0, 16).replace("T", " ")} |`
  ),
  "",
].join("\n");
writeFileSync("gradebook/GRADEBOOK.md", md);
// ---- unmatched submissions ----------------------------------------------
// A submission repo whose name no activity claimed is invisible: it is never
// cloned, never graded, and nothing warns you. Report it every sweep so a
// misnamed repo costs a day instead of a term. Two buckets are reported: repos
// carrying THIS section's token that no activity took, and repos carrying an
// activity id but no section token at all (those belong to nobody). A repo
// naming a DIFFERENT four-digit section is deliberately not reported here - it
// is presumed to be a sibling section's, and cross-section orphans surface in
// tools/org-audit.mjs instead.
//
// This is computed from the FULL policy, never from what this run happened to
// grade, so `--only` and `--repo` produce the same report as a whole sweep.
{
  const ACTIVITY = /(?:^|-)(m\d+a\d+|prelim|midterm|q\d+)(?:-|$)/;
  const sec = String(section).toLowerCase();
  const claimedByAny = (name) => allAssignments.some(
    (a) => a.namePrefix && matchesActivity(name, a.namePrefix) && inSection(name));
  const unmatched = [];
  for (const name of allRepos()) {
    const c = canon(name);
    if (INFRA.test(c) || claimedByAny(name) || !ACTIVITY.test(c)) continue;
    if (c.includes(`-${sec}-`)) unmatched.push([name, "names this section but matches no activity id"]);
    else if (!/-\d{4}(-|$)/.test(c)) unmatched.push([name, "has an activity id but no section in the name"]);
  }
  const um = [
    `# Unmatched submission repos - section ${section}`,
    "",
    unmatched.length
      ? `**${unmatched.length} repo(s) look like submissions but were NOT graded.** Rename them to \`<id>-${section}-<handle>\` (\`gh repo rename\`), then re-run the sweep. GitHub redirects the old URL, so a student's existing clone keeps working.`
      : "No unmatched submission repos. Every repo naming this section was claimed by an activity.",
    "",
    ...(unmatched.length ? ["| Repo | Why it was skipped |", "| --- | --- |",
      ...unmatched.map(([n, w]) => `| \`${n}\` | ${w} |`), ""] : []),
  ].join("\n");
  writeFileSync("gradebook/UNMATCHED.md", um);
  if (unmatched.length) console.log(`\nUNMATCHED: ${unmatched.length} repo(s) look like submissions but were not graded - see gradebook/UNMATCHED.md`);
}

console.log("\ngradebook written:");
console.log(md);
console.log("\n(grading only; deliver to students with: node tools/publish-grades.mjs " + section + " --execute  - after setting \"publish\": true on the ready activities)");
