// Where a finals deliverable actually is, read from the link the student
// submitted in Canvas.
//
// The finals activities are `submit: "url"`: every student pastes a GitHub link
// into Canvas, and that link names the exact file or folder they want graded.
// The two finals tools used to ignore it and guess instead (grade-workspace-docs
// read a whole workspace zone, grade-external-repos read a link out of
// project/README.md). Measured on one section on 2026-10-01, the guess was wrong
// for about four submissions in ten: the work was in the student's own project
// repo, in a PDF, in the other zone, or the link pointed at instructor content.
// A note drafted from the wrong source does not come out vague, it comes out
// confidently wrong, so the link is now the source of truth and the old guess is
// only the fallback when there is no usable link.
//
// The student is joined to their Canvas submission with the SAME consolidate +
// matchGroups path canvas-push uses at delivery, so the link we grade from and
// the Canvas cell the grade later lands in belong to the same person.
//
// Each resolved row is graded at the state its files had at the deadline
// (or at the moment of a late submission), not at today's HEAD: a week 1 report
// edited during week 2 must be graded as it stood in week 1. Edits after that
// cutoff are counted and reported to the marker, never graded.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { consolidate, matchGroups, makeIdResolver, loadGradebook, loadPolicy } from "./gradebook.mjs";
import { runNotesPass } from "./ai-feedback.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1e8 }).trim();
const quiet = (cmd) => execSync(cmd, { stdio: ["ignore", "ignore", "ignore"] });
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---- Canvas --------------------------------------------------------------

async function canvasGetAll(base, token, path) {
  let url = `${base}/api/v1${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}: ${(await res.text()).slice(0, 300)}`);
    out.push(...(await res.json()));
    const next = (res.headers.get("link") || "").split(",").find((s) => s.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
  }
  return out;
}

// workspaces: [{ name, num, email }] (identity from each workspace's student.json)
// Returns { links: Map("<ws>|<id>" -> sub), unmatched: [...], missingAssignments: [...] }
// where sub = { url, submittedAt, dueAt, late, cutoff }.
export async function canvasSubmissionLinks({ activities, workspaces, rows, section, policy }) {
  const base = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
  const token = process.env.CANVAS_TOKEN || "";
  const courseId = process.env.CANVAS_COURSE_ID || "";
  if (!base || !token || !courseId) {
    throw new Error("CANVAS_BASE_URL, CANVAS_TOKEN and CANVAS_COURSE_ID are required to read the submitted links (pass --zone-only to grade from the workspace zones without them).");
  }
  const students = await canvasGetAll(base, token, `/courses/${courseId}/users?enrollment_type[]=student&include[]=email`);
  const canvasAssignments = await canvasGetAll(base, token, `/courses/${courseId}/assignments`);
  const resolveId = makeIdResolver(policy);
  const wanted = new Set(activities.map((a) => a.id));
  const byOurId = new Map();
  for (const ca of canvasAssignments) {
    const id = resolveId(ca.name);
    if (id && wanted.has(id) && !byOurId.has(id)) byOurId.set(id, ca);
  }

  // One synthetic row per workspace, carrying its student.json identity, joined
  // into the real gradebook rows so a workspace inherits the identity its
  // owner's submission repos already carry (the repo-stem bridge).
  const wsRows = workspaces.map((w) => ({ repo: w.name, assignment: "", num: w.num || "", email: w.email || "", github: "", name: "", gradedAt: "" }));
  const groups = consolidate([...rows, ...wsRows], section);
  const { pairs, unmatched } = matchGroups(groups, students, {
    sisOf: (s) => s.sis_user_id || "",
    loginOf: (s) => s.login_id || s.email || "",
    nameOf: (s) => s.name,
  });
  const wsNames = new Set(workspaces.map((w) => w.name));
  const studentOfWs = new Map();
  const ambiguous = [];
  for (const { group, student } of pairs) {
    const mine = [...new Set(group.rows.map((r) => r.repo).filter((r) => wsNames.has(r)))];
    if (mine.length > 1) { ambiguous.push(...mine); continue; }
    if (mine.length === 1) studentOfWs.set(mine[0], student.id);
  }
  const unmatchedWs = [
    ...ambiguous.map((w) => ({ ws: w, reason: "two workspaces joined to one Canvas student" })),
    ...unmatched.flatMap((u) => u.group.rows.filter((r) => wsNames.has(r.repo)).map((r) => ({ ws: r.repo, reason: u.reason }))),
  ];

  const links = new Map();
  for (const [id, ca] of byOurId) {
    const subs = await canvasGetAll(base, token, `/courses/${courseId}/assignments/${ca.id}/submissions`);
    const byUser = new Map(subs.map((s) => [s.user_id, s]));
    for (const [ws, uid] of studentOfWs) {
      const s = byUser.get(uid);
      const dueAt = s?.cached_due_date || ca.due_at || null;
      const submitted = s && s.workflow_state !== "unsubmitted" && s.submitted_at;
      const late = !!(submitted && s.late);
      // On time: everything committed up to the deadline counts. Late: the work
      // as it stood when the student submitted. No deadline at all: HEAD.
      const cutoff = submitted ? (late || !dueAt ? s.submitted_at : dueAt) : dueAt;
      links.set(`${ws}|${id}`, {
        url: submitted ? (s.url || "") : "",
        submittedAt: submitted ? s.submitted_at : null,
        submissionType: s?.submission_type || null,
        dueAt, late, cutoff,
      });
    }
  }
  return {
    links,
    unmatched: unmatchedWs,
    missingAssignments: activities.map((a) => a.id).filter((id) => !byOurId.has(id)),
  };
}

// ---- links ---------------------------------------------------------------

// github.com/<owner>/<repo>[/(blob|tree)/<ref>/<path>] and the raw host. Returns
// null for anything that is not a GitHub repository link.
export function parseGithubUrl(url) {
  if (!url) return null;
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const parts = u.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (/^(www\.)?github\.com$/i.test(u.hostname)) {
    if (parts.length < 2) return null;
    const [owner, rawRepo, kind, ref, ...rest] = parts;
    const repo = rawRepo.replace(/\.git$/i, "");
    // blob/tree are the usual shapes; edit/blame/raw are the same file seen
    // from another button, and students paste whatever was in the address bar.
    if (["blob", "tree", "edit", "blame", "raw"].includes(kind) && ref) return { owner, repo, ref, path: rest.join("/"), kind: kind === "tree" ? "tree" : "blob" };
    return { owner, repo, ref: null, path: "", kind: "root" };
  }
  if (/^raw\.githubusercontent\.com$/i.test(u.hostname) && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return { owner, repo, ref, path: rest.join("/"), kind: "blob" };
  }
  return null;
}

// ---- repositories at a point in time --------------------------------------

// Clones each repository once (full commit graph, blobs on demand) and
// materializes per-row snapshots out of it with `git archive`, so two
// activities graded from the same repo at different deadlines never share a
// working tree.
export class RepoCache {
  constructor(work) {
    this.root = `${work}/_repos`;
    this.ok = new Map();   // full -> dir | null
    mkdirSync(this.root, { recursive: true });
  }
  get(full) {
    if (this.ok.has(full)) return this.ok.get(full);
    const dir = `${this.root}/${full.replace(/[^\w.-]/g, "__")}`;
    rmSync(dir, { recursive: true, force: true });
    let got = null;
    try { quiet(`gh repo clone ${q(full)} ${q(dir)} -- -q --filter=blob:none`); got = dir; }
    catch {
      try { quiet(`gh repo clone ${q(full)} ${q(dir)} -- -q`); got = dir; } catch { got = null; }
    }
    this.ok.set(full, got);
    return got;
  }
}

function revAt(dir, ref, cutoff) {
  const tip = ref && (() => { try { return sh(`git -C ${q(dir)} rev-parse --verify -q ${q(`origin/${ref}`)}`); } catch { try { return sh(`git -C ${q(dir)} rev-parse --verify -q ${q(ref)}`); } catch { return ""; } } })() || "HEAD";
  if (!cutoff) return { sha: sh(`git -C ${q(dir)} rev-parse ${q(tip)}`), tip, beforeAny: false };
  const sha = sh(`git -C ${q(dir)} rev-list -1 --before=${q(cutoff)} ${q(tip)}`);
  if (sha) return { sha, tip, beforeAny: false };
  // Nothing existed before the cutoff: grade the earliest state we have and say so.
  return { sha: sh(`git -C ${q(dir)} rev-list --max-parents=0 ${q(tip)}`).split("\n")[0], tip, beforeAny: true };
}

// Writes the repo's `path` (file or folder, "" for the whole repo) as of the
// cutoff into `dest`. Returns { kind: "file"|"dir"|"missing", sha, editsAfter, beforeAny }.
export function snapshot(cache, full, { ref = null, path = "", cutoff = null }, dest) {
  const dir = cache.get(full);
  if (!dir) return { kind: "clone-failed" };
  const { sha, tip, beforeAny } = revAt(dir, ref, cutoff);
  const clean = String(path || "").replace(/^\/+|\/+$/g, "");
  let type = "";
  try { type = sh(`git -C ${q(dir)} cat-file -t ${q(`${sha}:${clean}`)}`); } catch { type = ""; }
  let editsAfter = 0;
  try { editsAfter = Number(sh(`git -C ${q(dir)} rev-list --count ${q(`${sha}..${tip}`)} -- ${clean ? q(clean) : "."}`)) || 0; } catch { editsAfter = 0; }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (!type) return { kind: "missing", sha, editsAfter, beforeAny, path: clean };
  quiet(`git -C ${q(dir)} archive ${q(sha)} ${clean ? q(clean) : ""} | tar -x -C ${q(dest)}`);
  return { kind: type === "blob" ? "file" : "dir", sha, editsAfter, beforeAny, path: clean, historyDir: dir };
}

// Is the linked content/ file byte-identical to a version of the same path in
// THIS teacher repo (the tool runs from it, and publish-material copies
// content/ into every workspace)? Any version counts, so a workspace holding
// last month's template is still recognised as the template.
const teacherBlobs = new Map();
function isInstructorCopy(owner, ws, L) {
  if (!teacherBlobs.has(L.path)) {
    const set = new Set();
    try {
      for (const c of sh(`git rev-list HEAD -- ${q(L.path)}`).split("\n").filter(Boolean)) {
        try { set.add(sh(`git rev-parse ${q(`${c}:${L.path}`)}`)); } catch { /* deleted in that commit */ }
      }
    } catch { /* not a git checkout */ }
    teacherBlobs.set(L.path, set);
  }
  const known = teacherBlobs.get(L.path);
  if (!known.size) return false; // the instructor never had this file: the student made it
  let sha = "";
  try { sha = sh(`gh api ${q(`repos/${owner}/${ws}/contents/${L.path.split("/").map(encodeURIComponent).join("/")}${L.ref ? `?ref=${encodeURIComponent(L.ref)}` : ""}`)} -q .sha`); } catch { return false; }
  return known.has(sha);
}

// student.json from a workspace (number + email are the Canvas join keys).
export function workspaceIdentity(owner, ws) {
  try {
    const j = JSON.parse(Buffer.from(JSON.parse(sh(`gh api ${q(`repos/${owner}/${ws}/contents/student.json`)}`)).content, "base64").toString("utf8"));
    return { name: ws, num: j.studentNumber || "", email: j.email || j.studentEmail || "" };
  } catch {
    return { name: ws, num: "", email: "" };
  }
}

// The paragraph the marker reads first: what the student submitted, what was
// actually read, and what to do when the deliverable is not in it.
export function sourceNote(r) {
  const lines = [];
  if (r.link) lines.push(`Link the student submitted in Canvas: ${r.link}`);
  else lines.push("The student did not submit a link in Canvas for this activity.");
  if (r.submittedAt) lines.push(`Submitted ${r.submittedAt}${r.late ? " (LATE)" : ""}; due ${r.dueAt || "not set"}.`);
  lines.push(`Graded from: ${r.gradedFrom}.`);
  if (r.reason) lines.push(r.reason);
  if (r.beforeAny) lines.push("Nothing in that location was committed before the cutoff, so this is its EARLIEST committed state, which is later than the deadline. Report that in the instructor half.");
  if (r.editsAfter) lines.push(`${r.editsAfter} later commit(s) changed this location after the cutoff. They are NOT graded; do not credit anything the student added after the deadline.`);
  lines.push(
    "If the deliverable for this activity is not in the Student source below (wrong file linked, an empty folder, only a file that could not be read as text), do NOT score it as missing work and do NOT tell the student they did not submit.",
    "Write the student-facing half as a short neutral note that the submission could not be located for review, and in the instructor half write `Proposed total: HOLD - <what was missing and where you looked>` instead of a number, so the row waits for a human.",
  );
  return lines.join("\n");
}

// ---- one row -------------------------------------------------------------

// Decide what to read for one (workspace, activity) and materialize it.
//   sub       the Canvas submission from canvasSubmissionLinks (or undefined)
//   fallback  () => { full, path, label } | null: the tool's old guess (the
//             workspace zone, or the repo named in project/README.md)
// Returns { row } with the notes-pass row fields, or { skip, reason } when the
// row must not be drafted at all (a link to ANOTHER student's workspace: a
// draft from it would grade one student on another's work).
export function resolveFinalsRow({ ws, a, sub, owner, prefix, cache, work, fallback, dryRun = false }) {
  const link = sub?.url || "";
  const L = parseGithubUrl(link);
  const cutoff = sub?.cutoff || null;
  const reasons = [];
  let target = null; // { full, path, ref, label, scoped }

  if (!link) {
    reasons.push(sub?.submittedAt ? `The Canvas submission is a ${sub.submissionType || "non-link"} submission, not a link.` : "No link in Canvas.");
  } else if (!L) {
    let host = "";
    try { host = new URL(link).hostname; } catch { host = "an unparseable address"; }
    reasons.push(`The submitted link points at ${host}, not a GitHub repository, so the work behind it was not read. The instructor must open the link by hand.`);
  } else if (L.owner.toLowerCase() === owner.toLowerCase()) {
    const repoLc = L.repo.toLowerCase();
    if (repoLc === ws.toLowerCase()) {
      const top = L.path.split("/")[0];
      if (!L.path) reasons.push("The link is the workspace root, not a file or folder.");
      else if (top === "grades") reasons.push("The link points into the instructor-owned `grades/` folder, which is not the student's work.");
      else if (top === "content" && isInstructorCopy(owner, ws, L)) reasons.push(`The link is the instructor's own \`${L.path}\`, unchanged, which is course material rather than the student's work.`);
      else if (top === "content") {
        // A file the student created or rewrote inside content/ is still their
        // work, however odd the place: 7 of 18 such links on 2026-10-01 were.
        target = { full: `${owner}/${ws}`, path: L.path, ref: L.ref, label: `the linked \`${L.path}\` in the student's workspace`, scoped: true };
        reasons.push(`The link is inside the instructor's \`content/\` folder but is not an unchanged course file, so it is graded as the student's own work.`);
      } else {
        target = { full: `${owner}/${ws}`, path: L.path, ref: L.ref, label: `the linked \`${L.path}\` in the student's workspace`, scoped: true };
        if (a.sourceSubpath && top !== a.sourceSubpath) reasons.push(`The link is in \`${top}/\` while this activity's usual place is \`${a.sourceSubpath}/\`; graded from the link.`);
      }
    } else if (prefix && repoLc.startsWith(prefix.toLowerCase())) {
      // On a group deliverable (`"groupWork": true`) the shared report or
      // division-of-work file lives in ONE member's workspace and every member
      // submits that link, so a groupmate's workspace is the right source. On
      // individual work the same link would grade one student on another's
      // writing, so it is held for a human.
      if (!a.groupWork) return { skip: true, reason: `links another student's workspace (${L.repo})` };
      const gTop = L.path.split("/")[0];
      if (gTop === "grades" || (gTop === "content" && isInstructorCopy(owner, L.repo, L))) return { skip: true, reason: `links unchanged instructor material in a groupmate's workspace (${L.repo})` };
      // A bare workspace link means "the group's work is over there": read the
      // activity's zone in that workspace.
      const gPath = L.path || a.sourceSubpath || "";
      if (!gPath) return { skip: true, reason: `links a groupmate's workspace root (${L.repo}) and the activity names no zone` };
      target = { full: `${owner}/${L.repo}`, path: gPath, ref: L.ref, label: L.path ? `the linked \`${L.path}\` in a groupmate's workspace (${L.repo})` : `the \`${gPath}/\` folder of a groupmate's workspace (${L.repo}), whose root was linked`, scoped: true };
      reasons.push("This is a group deliverable kept in a groupmate's workspace, so every member of the group is graded from the same file. Judge it as the group's work; where a division-of-work record names who did what, use it in the instructor half for this member's share.");
    } else {
      target = { full: `${owner}/${L.repo}`, path: L.path, ref: L.ref, label: `\`${L.path || "the repository root"}\` of the course repository ${L.repo}`, scoped: !!L.path };
    }
  } else {
    target = { full: `${L.owner}/${L.repo}`, path: L.path, ref: L.ref, label: L.path ? `the linked \`${L.path}\` in the student's own repository ${L.owner}/${L.repo}` : `the student's own repository ${L.owner}/${L.repo}`, scoped: !!L.path };
  }

  const dest = `${work}/_rows/${a.id}/${ws}`;
  const attempt = (t) => {
    if (dryRun) return { kind: "planned" };
    let snap = snapshot(cache, t.full, { ref: t.ref, path: t.path, cutoff }, dest);
    if (snap.kind === "missing" && cutoff) {
      // Not there at the deadline: look at the latest state, and say it is late.
      const later = snapshot(cache, t.full, { ref: t.ref, path: t.path, cutoff: null }, dest);
      if (later.kind === "file" || later.kind === "dir") snap = { ...later, beforeAny: true, editsAfter: 0 };
    }
    return snap;
  };

  // `"linkScope": "repo"` (the documentation updates): the rubric spans the
  // README, the docs and the checklist while students link ONE of them, so the
  // linked file is pinned first and its surroundings come too: the whole repo
  // for a student's own repository, the activity's zone for the workspace
  // (never the whole workspace, which is mostly instructor content).
  let linkedPin = "";
  if (target && a.linkScope === "repo" && target.path) {
    const inWs = target.full.toLowerCase() === `${owner}/${ws}`.toLowerCase();
    const wider = inWs ? (a.sourceSubpath || "") : "";
    if (!inWs || (wider && target.path.split("/")[0] === wider)) {
      linkedPin = target.path;
      target = { ...target, path: wider, label: `${target.label}, read with ${inWs ? `the rest of the workspace \`${wider}/\` folder` : "the rest of that repository"}`, scoped: inWs };
    }
  }

  let snap = null;
  if (target) {
    snap = attempt(target);
    if (linkedPin && (snap.kind === "file" || snap.kind === "dir")) {
      if (!existsSync(`${dest}/${linkedPin}`)) reasons.push(`The linked \`${linkedPin}\` was not in that state of the repository; its surroundings are graded.`);
      else snap = { ...snap, kind: "dir", pinned: linkedPin };
    }
    if (snap.kind === "clone-failed") { reasons.push(`The linked repository ${target.full} could not be cloned (private, renamed or deleted).`); target = null; }
    else if (snap.kind === "missing") { reasons.push(`The linked \`${target.path}\` does not exist in ${target.full}.`); target = null; }
  }
  let via = "link";
  if (!target) {
    const fb = fallback();
    if (!fb) return { skip: true, reason: `no usable link and nothing to fall back to (${reasons.join(" ") || "no source"})` };
    target = { ...fb, scoped: fb.scoped ?? true };
    via = "fallback";
    snap = attempt(target);
    if (snap.kind === "clone-failed" || snap.kind === "missing") {
      return { skip: true, reason: `no usable link, and the fallback ${fb.label} is ${snap.kind === "missing" ? "empty or absent" : "not clonable"} (${reasons.join(" ")})` };
    }
    reasons.push(`Fell back to ${fb.label}.`);
  }

  // What to pin to the front of the source: the linked file itself; else, for a
  // whole repository, the activity's declared deliverable, or its README when
  // the activity is a workspace document (the documentation update lives there).
  let pin = "";
  if (snap.pinned) pin = [snap.pinned, "README.md"];
  else if (snap.kind === "file") pin = target.path;
  else if (!target.path && a.deliverable) pin = a.deliverable;
  else if (!target.path && a.sourceSubpath) pin = "README.md";
  const row = {
    repo: ws, assignment: a.id, score: 0, passed: 0, total: 1, failures: [], notes: "", aiScore: "",
    clone: dest, sourceSubpath: "", pin, scoped: target.scoped,
    historyRepo: snap.historyDir, historyRev: snap.sha,
    sourceNote: sourceNote({
      link, submittedAt: sub?.submittedAt, dueAt: sub?.dueAt, late: sub?.late,
      gradedFrom: `${target.label}${snap.sha ? `, as of commit ${snap.sha.slice(0, 7)}` : ""}${cutoff ? ` (the state at ${cutoff})` : ""}`,
      reason: reasons.join(" "), beforeAny: snap.beforeAny, editsAfter: snap.editsAfter,
    }),
  };
  return { row, via, kind: snap.kind, target: target.full + (target.path ? `:${target.path}` : "") , reasons };
}

// ---- the shared tool loop ------------------------------------------------

// Both finals tools run this. They differ only in which activities they own
// (`select`) and what to read when a student left no usable link (`fallback`).
//   node tools/<tool>.mjs <section> [--only=<id>] [--force] [--dry-run] [--zone-only]
// --zone-only skips Canvas and grades every row from the fallback, the
// behaviour before 2026-10-01; it is for a section with no Canvas course.
export async function runFinalsTool({ tool, work, select, fallback, describe }) {
  const section = process.argv[2];
  const args = process.argv.slice(3);
  const onlyId = (args.find((x) => x.startsWith("--only=")) || "").split("=")[1] || null;
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const zoneOnly = args.includes("--zone-only");
  if (!section) {
    console.error(`usage: ${tool}.mjs <section> [--only=<id>] [--force] [--dry-run] [--zone-only]`);
    process.exit(1);
  }
  const OWNER = process.env.GRADE_OWNER || sh("gh api user -q .login");
  const PREFIX = process.env.WORKSPACE_PREFIX;
  if (!PREFIX) {
    console.error("WORKSPACE_PREFIX env is required (e.g. student-<subject>-<section>-). It is set per section in the workflow.");
    process.exit(1);
  }
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // Read the RAW assignments array (not loadPolicy, which returns a normalized
  // Map keyed by id and drops sourceSubpath); the notes pass needs the raw objects.
  const assignments = JSON.parse(readFileSync("grader/assignments.json", "utf8"));
  const activities = assignments.filter((x) => select(x) && (!onlyId || x.id === onlyId));
  if (!activities.length) {
    console.error(onlyId ? `No ${describe} activity ${onlyId} in assignments.json.` : `No ${describe} activities in assignments.json.`);
    process.exit(1);
  }
  console.log(`Owner ${OWNER}, section ${section}, prefix ${PREFIX}`);
  console.log(`${describe} activities: ${activities.map((x) => x.sourceSubpath ? `${x.id}(${x.sourceSubpath})` : x.id).join(", ")}`);

  // List the section's workspaces, refusing to report a clean run over nobody.
  let names = null;
  for (let attempt = 1; attempt <= 3 && !names; attempt++) {
    try { names = JSON.parse(sh(`gh repo list ${q(OWNER)} --limit 5000 --json name -q '[.[].name]'`)); }
    catch (e) { console.error(`attempt ${attempt}: listing ${OWNER} failed (${e.message.split("\n")[0]})`); }
  }
  if (!names) {
    console.error(`Listing ${OWNER} returned no repos after 3 attempts. Refusing to report a clean run that graded nobody.`);
    process.exit(1);
  }
  const workspaces = names.filter((n) => n.toLowerCase().startsWith(PREFIX.toLowerCase()));
  console.log(`Resolved ${workspaces.length} workspace(s) for ${PREFIX}.`);

  let existing = [];
  try { existing = loadGradebook("gradebook/grades.csv", section).rows; } catch { existing = []; }
  const hasNote = new Set(existing.filter((r) => r.notes).map((r) => `${r.repo}|${r.assignment}`));

  let links = new Map(), unmatched = [], missingAssignments = [];
  if (!zoneOnly) {
    const ids = workspaces.map((w) => workspaceIdentity(OWNER, w));
    ({ links, unmatched, missingAssignments } = await canvasSubmissionLinks({ activities, workspaces: ids, rows: existing, section, policy: loadPolicy() }));
    console.log(`Canvas: ${links.size} (workspace, activity) pair(s) joined; ${unmatched.length} workspace(s) not joined to a Canvas student.`);
    if (missingAssignments.length) console.log(`  no Canvas assignment found for: ${missingAssignments.join(", ")} (those rows use the fallback)`);
  }
  const unmatchedWs = new Set(unmatched.map((u) => u.ws));

  const cache = new RepoCache(work);
  const rows = [], gradedThisRun = new Set(), skipped = [], ledger = [];
  const tally = new Map();
  for (const ws of workspaces) {
    for (const a of activities) {
      const key = `${ws}|${a.id}`;
      if (hasNote.has(key) && !force) continue; // keep an existing (maybe reviewed) note
      const sub = links.get(key);
      const res = resolveFinalsRow({ ws, a, sub, owner: OWNER, prefix: PREFIX, cache, work, fallback: () => fallback({ ws, a, owner: OWNER }), dryRun });
      if (res.skip) {
        skipped.push({ ws, id: a.id, reason: res.reason });
        tally.set("SKIPPED", (tally.get("SKIPPED") || 0) + 1);
        continue;
      }
      const t = `${a.id} ${res.via}`;
      tally.set(t, (tally.get(t) || 0) + 1);
      ledger.push({ ws, id: a.id, via: res.via, target: res.target, late: !!sub?.late, unjoined: unmatchedWs.has(ws), reasons: res.reasons.join(" ") });
      rows.push(res.row);
      gradedThisRun.add(key);
    }
  }

  console.log("");
  for (const [k, v] of [...tally].sort()) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`\n${rows.length} notes-input file(s) to write, ${skipped.length} row(s) held back for a human.`);

  // The instructor reads this before generating a single draft: every row that
  // fell back, every link that could not be followed, every row held back.
  const report = [
    `# Finals source resolution: ${tool} (section ${section})`,
    "",
    `${dryRun ? "Dry run (planned, nothing cloned)" : "Run"} ${new Date().toISOString()}. ${rows.length} row(s) resolved, ${skipped.length} held back.`,
    "",
    zoneOnly ? "**--zone-only: Canvas links were NOT read; every row is the fallback.**\n" : "",
    unmatched.length ? `## Workspaces not joined to a Canvas student (${unmatched.length})\n\nTheir rows use the fallback. Fix the identity (student.json) before trusting them.\n\n${unmatched.map((u) => `- ${u.ws}: ${u.reason}`).join("\n")}\n` : "",
    skipped.length ? `## Held back, NOT drafted (${skipped.length})\n\n${skipped.map((x) => `- ${x.id} ${x.ws}: ${x.reason}`).join("\n")}\n` : "",
    "## Resolved rows",
    "",
    "| Activity | Workspace | Read from | Via | Note |",
    "| --- | --- | --- | --- | --- |",
    ...ledger.map((x) => `| ${x.id} | ${x.ws} | ${x.target} | ${x.via}${x.late ? " (late)" : ""} | ${x.reasons.replace(/\|/g, "/")} |`),
    "",
  ].filter((l) => l !== "").join("\n");
  mkdirSync("gradebook", { recursive: true });
  const reportPath = `gradebook/finals-sources-${tool}${onlyId ? `-${onlyId}` : ""}.md`;
  writeFileSync(reportPath, report + "\n");
  console.log(`Report: ${reportPath}`);

  if (dryRun) {
    console.log("Dry run - nothing cloned, no inputs written.");
    return;
  }
  // The notes pass reads each row's snapshot (row.clone) and never sets a score.
  await runNotesPass(rows, assignments, gradedThisRun, { work });
  console.log("\nDone. Generate drafts with the Course Console feedback prompt, review, then apply. Delivery is the separate human-lane publish step.");
}
