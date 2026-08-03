// Shared gradebook logic for the Canvas integrations.
//
// Both tools/canvas-export.mjs (offline CSV) and tools/canvas-push.mjs (live
// API) read the same gradebook/grades.csv, consolidate a student's many
// (repo, assignment) rows into one student, and decide how a passed/total score
// becomes Canvas points. That matching is the subtle part, so it lives here once
// rather than being copied into both tools.

import { readFileSync, existsSync } from "node:fs";

// ---- CSV helpers (same dialect as grade-sweep.mjs) -----------------------
export const parseCsvLine = (line) => {
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
export const csvField = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Split a whole file into logical CSV rows, honoring quoted newlines.
export const parseCsv = (text) => {
  const rows = [];
  let row = [], cur = "", q = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
};

// ---- normalization -------------------------------------------------------
export const normNum = (s) => String(s ?? "").trim().replace(/^\d{4}-/, "");   // drop "2026-" year prefix
export const normEmail = (s) => String(s ?? "").trim().toLowerCase();
export const normGh = (s) =>
  String(s ?? "").trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\/github\.com\//, "");
// Leading m#a# / q# token of a label (Canvas header or assignment name) -> our id.
// Also maps a whole-name "prelim" / "midterm" (exact, case-insensitive) so those
// named activities link to their Canvas assignment. Exact-only on purpose: it
// must NOT swallow "Prelim Journal Submission" / "Prelim Exam - ..." etc.
export const tokenToId = (label) => {
  const s = String(label).trim();
  const m = s.match(/^\s*(m\d+a\d+|q\d+)\b/i);
  if (m) return m[1].toLowerCase();
  const lc = s.toLowerCase();
  return (lc === "prelim" || lc === "midterm") ? lc : null;
};
// Canvas name -> our id, with an escape hatch for assignments whose live Canvas
// name carries no readable id ("Final Project Proposal Submission"). An activity
// may declare `canvasName` in assignments.json; that exact name (case- and
// space-insensitive) wins, and anything else falls through to tokenToId. Use it
// to ADOPT an assignment that already exists in Canvas, instead of renaming it
// under students who have already submitted. Build one per tool from its policy.
// A Canvas gradebook CSV header is "<assignment name> (<canvas id>)", so the
// trailing id is dropped before matching - an assignment name never ends that way.
const aliasKey = (label) =>
  String(label ?? "").replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
export const makeIdResolver = (policy) => {
  const alias = new Map();
  for (const [id, a] of policy || []) {
    if (a && a.canvasName) alias.set(aliasKey(a.canvasName), id);
  }
  return (label) => alias.get(aliasKey(label)) ?? tokenToId(label);
};
// The student's chosen suffix in a repo name, e.g. m1a1-2125-Catap -> "catap",
// student-6ADET-2125-skpriniel -> "skpriniel". Bridges a blank-identity row to a
// sibling that has identity, via the github-account namespace.
export const repoStem = (repo, section) => {
  const r = String(repo);
  const i = section ? r.toLowerCase().indexOf(`-${String(section).toLowerCase()}-`) : -1;
  const tail = i >= 0 ? r.slice(i + String(section).length + 2) : r.replace(/^[^-]*-/, "");
  return tail.toLowerCase();
};

// Must stay in step with tokenToId below, which already resolves an exact
// "prelim"/"midterm" to an id. When this was stricter than that, consolidate()
// silently dropped every prelim row, so canvas-push could never see one.
const isAssignmentId = (id) => /^(m\d+a\d+|q\d+|prelim|midterm)$/i.test(String(id));

// ---- assignment policy ---------------------------------------------------
// manual:          entirely hand-graded -> never sent to Canvas. AI-graded
//                  rubric projects are manual: you review the AI's proposed
//                  design score, then publish the total yourself.
// totalPoints: <n> what the activity is worth in Canvas. Stored only to be
//                  reconciled against Canvas's live points_possible (a mismatch
//                  is flagged); RUBRIC.md owns how those points are distributed.
// autoPoints: <n>  legacy objective/subjective split (objective n points sent,
//                  rest a manual top-up). Superseded by totalPoints + manual for
//                  AI-graded activities; still honoured if a class sets it.
// locked:          a finalized activity -> a first grade is still sent, but the
//                  push will NOT overwrite a grade Canvas already has.
// submit: <how>    where the student submits, for Canvas-shell authoring only:
//                  "repo" (push to GitHub, the default for test/AI activities),
//                  "url" (paste a link in Canvas - manual/badge activities), or
//                  "canvas" (taken in Canvas, e.g. a quiz). Never affects grading;
//                  canvas-sync-assignments reads it to pick the Canvas submission
//                  type. A "url" activity has no submission repo, so the sweep
//                  clones nothing and it is graded by hand in Canvas.
// content: <slug>  the content/ unit folder that teaches this activity, e.g.
//                  "publish-portfolio". Used only to render the workspace-relative
//                  lesson pointer in the generated Canvas description.
// title: <text>    human title for the Canvas assignment (name becomes
//                  "<ID>: <title>"); optional, id-only if absent.
export function loadPolicy(path = "grader/assignments.json") {
  const policy = new Map();
  const num = (v) => (v != null && Number.isFinite(+v) ? +v : null);
  try {
    for (const a of JSON.parse(readFileSync(path, "utf8"))) {
      policy.set(a.id, {
        manual: !!a.manual, autoPoints: num(a.autoPoints), totalPoints: num(a.totalPoints), locked: !!a.locked,
        // AI-graded rubric activities are held: the sweep + AI propose a grade,
        // you review/edit it, then it is published. Never hand-entered, and not
        // auto-pushed with the raw test score.
        aiGraded: !!a["ai-grading"], feedback: a.feedback || null,
        // Grades + feedback for an activity are delivered to students ONLY when
        // `publish: true` (default false). The publish workflow honors this; the
        // grade workflow never touches student repos.
        publish: !!a.publish,
        // Canvas-authoring metadata (grading-neutral; see the block above).
        type: a.type || null, submit: a.submit || null, content: a.content || null, title: a.title || null,
        // Exact live Canvas assignment name to adopt, when it carries no id token.
        canvasName: a.canvasName || null,
      });
    }
  } catch { /* no assignments.json - treat all as fully auto */ }
  return policy;
}

// ---- read + consolidate the gradebook ------------------------------------
export function loadGradebook(path = "gradebook/grades.csv", sectionArg = null) {
  if (!existsSync(path)) throw new Error(`no ${path} - run the grade sweep first`);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const ci = {
    repo: col("repo"), github: col("githubAccount"), name: col("fullName"),
    num: col("studentNumber"), email: col("studentEmail"), classCode: col("classCode"),
    assignment: col("assignment"), sha: col("sha"), passed: col("passed"), total: col("total"),
    gradedAt: col("gradedAt"), late: col("late"), aiScore: col("aiScore"), notes: col("notes"),
  };
  const rows = lines.slice(1).filter(Boolean).map((ln) => {
    const f = parseCsvLine(ln);
    return {
      repo: f[ci.repo], github: f[ci.github], name: f[ci.name], num: f[ci.num],
      email: f[ci.email], classCode: f[ci.classCode], assignment: f[ci.assignment],
      sha: ci.sha >= 0 ? f[ci.sha] || "" : "", passed: +f[ci.passed], total: +f[ci.total],
      gradedAt: f[ci.gradedAt] || "", late: ci.late >= 0 ? f[ci.late] === "true" : false,
      aiScore: ci.aiScore >= 0 ? (f[ci.aiScore] ?? "") : "", notes: ci.notes >= 0 ? (f[ci.notes] || "") : "",
    };
  });
  // Section: explicit, else the MOST COMMON classCode (mode, not "the only one" -
  // a single typo'd classCode like 2124 must not blank this out, since the
  // repo-stem bridge in consolidate() depends on knowing the section).
  const counts = {};
  for (const r of rows) if (r.classCode) counts[r.classCode] = (counts[r.classCode] || 0) + 1;
  const section = sectionArg || (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  return { rows, section };
}

// Group rows into students via union-find over shared keys: a normalized number,
// a normalized email, or a github account (a repo stem shares the github
// namespace so a blank-identity quiz row joins its owner's sibling rows).
// Returns an array of { rows, nums:Set, emails:Set, name, scores:Map }.
export function consolidate(rows, section) {
  const parent = rows.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const keyOwner = new Map();
  const keysFor = (r) => {
    const ks = [];
    if (normNum(r.num)) ks.push("num:" + normNum(r.num));
    if (normEmail(r.email)) ks.push("em:" + normEmail(r.email));
    if (normGh(r.github)) ks.push("gh:" + normGh(r.github));
    const stem = repoStem(r.repo, section);
    if (stem) ks.push("gh:" + stem);
    return ks;
  };
  rows.forEach((r, i) => {
    for (const k of keysFor(r)) {
      if (keyOwner.has(k)) union(i, keyOwner.get(k));
      else keyOwner.set(k, i);
    }
  });
  const byRoot = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, { rows: [], nums: new Set(), emails: new Set(), name: "" });
    const g = byRoot.get(root);
    g.rows.push(r);
    if (normNum(r.num)) g.nums.add(normNum(r.num));
    if (normEmail(r.email)) g.emails.add(normEmail(r.email));
    if (r.name && !g.name) g.name = r.name;
  });
  for (const g of byRoot.values()) {
    g.scores = new Map();   // ourId -> { passed, total, gradedAt, repo, sha, late, aiScore, notes }
    for (const r of g.rows) {
      if (!isAssignmentId(r.assignment)) continue;   // ignore non-assignment artifact values
      const prev = g.scores.get(r.assignment);
      if (!prev || r.gradedAt > prev.gradedAt) {
        g.scores.set(r.assignment, {
          passed: r.passed, total: r.total, gradedAt: r.gradedAt,
          repo: r.repo, sha: r.sha, late: r.late, aiScore: r.aiScore, notes: r.notes,
        });
      }
    }
  }
  return [...byRoot.values()];
}

// Match each grade group to a student record from any roster source. The
// accessors pull the join keys off whatever shape the roster rows are (CSV row,
// Canvas API user, ...). Returns matched pairs, the group-per-student map, and
// unmatched groups with a reason.
export function matchGroups(groups, students, { sisOf, loginOf, nameOf = () => "" }) {
  const byNum = new Map(), byEmail = new Map();
  for (const s of students) {
    const n = normNum(sisOf(s)); if (n && !byNum.has(n)) byNum.set(n, s);
    const e = normEmail(loginOf(s)); if (e && !byEmail.has(e)) byEmail.set(e, s);
  }
  const groupOf = new Map();   // student -> group
  const pairs = [], unmatched = [];
  for (const g of groups) {
    let student = null, via = null;
    for (const n of g.nums) if (byNum.has(n)) { student = byNum.get(n); via = `number ${n}`; break; }
    if (!student) for (const e of g.emails) if (byEmail.has(e)) { student = byEmail.get(e); via = `email ${e}`; break; }
    if (student) {
      if (groupOf.has(student)) {
        unmatched.push({ group: g, reason: `collides with another grade group on ${nameOf(student)}` });
      } else {
        groupOf.set(student, g);
        pairs.push({ group: g, student, via });
      }
    } else {
      unmatched.push({
        group: g,
        reason: `no Canvas student for number(s) [${[...g.nums].join(", ") || "-"}] / email(s) [${[...g.emails].join(", ") || "-"}]`,
      });
    }
  }
  return { pairs, unmatched, groupOf };
}

// ---- authorship notice ---------------------------------------------------
// The instructor half of an AI feedback note ends with a private
// `AI-authored likelihood: low|medium|high` estimate. That line itself is never
// shown to a student, but from 2026-08-03 the instructor wants a student on the
// medium or high end told, plainly, that authorship is being watched: no score
// change, no penalty, no mention that a model produced the signal. Same single
// line for both tiers, deliberately - a "medium" student should not be able to
// infer they were rated lower risk than a "high" one.
export const AUTHORSHIP_NOTICE =
  "Note on authorship: parts of this submission read as more advanced than the work and pace I have seen from you so far. No penalty has been applied. Be ready to walk me through your code and explain your choices if I ask.";

// The note text (whole file, both halves) -> the notice, or "" for low/absent.
export const authorshipNotice = (note) =>
  /ai-authored likelihood:\s*(?:high|medium)\b/i.test(String(note ?? "")) ? AUTHORSHIP_NOTICE : "";

// passed/total -> Canvas points. Returns null when nothing should be written
// (no grade, or a 0/0 unbuildable submission). Subjective activities scale to
// their objective portion only; everything else scales to Points Possible.
export function pointsFor(score, { autoPoints = null, pointsPossible = null } = {}) {
  if (!score || !score.total) return null;
  const frac = score.passed / score.total;
  if (autoPoints != null) return Math.round(frac * autoPoints);
  if (pointsPossible != null) return Math.round(frac * pointsPossible);
  return score.passed;
}
