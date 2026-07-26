#!/usr/bin/env node
// Cross-check THIS section's gradebook against Canvas. Read-only against Canvas
// (it writes nothing to Canvas); it only emits a report into this repo.
//
// It answers four questions the dashboard cannot:
//   1. Identity   - does every gradebook studentNumber match a real Canvas
//                   enrollment? (and which Canvas students have no graded work)
//   2. Submission - for each graded activity, did the student actually SUBMIT
//                   on Canvas? Surfaces "graded here but no Canvas submission"
//                   and "submitted on Canvas but never graded" (a repo problem).
//   3. Readable   - is the Canvas submission attachment present, an image, and
//                   non-empty, so the system can actually read the screenshot?
//   4. Agreement  - where both sides have a grade, do the points agree?
//
// Auth (never commit these; the workflow injects them):
//   CANVAS_BASE_URL   e.g. https://hau.instructure.com
//   CANVAS_TOKEN      a Canvas access token (read is enough)
//   CANVAS_COURSE_ID  baked into the workflow env (this section's course)
//
// Usage:
//   node tools/canvas-crosscheck.mjs [--course=<id>] [--section=<code>]
//                                    [--report=<path>]
// Output: reports/canvas-crosscheck.md (rendered in the Course Console).

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseCsv, tokenToId, pointsFor, normNum, loadPolicy } from "./lib/gradebook.mjs";

// ---- args / env ----------------------------------------------------------
const arg = (name, def = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const section = arg("section") || process.env.SECTION || "";
const reportPath = arg("report", "reports/canvas-crosscheck.md");
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID in the env or pass --course=<id>"); process.exit(1); }

// ---- Canvas paginated GET ------------------------------------------------
async function canvasGet(path) {
  const out = [];
  let url = `${BASE}/api/v1${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
    out.push(...(await res.json()));
    const next = (res.headers.get("link") || "").split(",").find((p) => p.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
  }
  return out;
}
const isImage = (a) => /^image\//.test(a?.["content-type"] || a?.content_type || "") || /\.(png|jpe?g|webp|gif)$/i.test(a?.filename || "");

const F = { section, identity: [], gradedNotSubmitted: [], submittedNotGraded: [], unreadable: [], disagree: [], noWork: [], noCanvasGrade: [], coverage: null };

// ---- our gradebook: (num|activity) -> grade ------------------------------
const policy = loadPolicy("grader/assignments.json");
const gb = new Map();           // `${num}|${act}` -> { passed, total, aiScore, repo }
const numActs = new Map();      // num -> Set(activity)
if (existsSync("gradebook/grades.csv")) {
  const rows = parseCsv(readFileSync("gradebook/grades.csv", "utf8"));
  const H = rows.shift().reduce((m, h, i) => ((m[h] = i), m), {});
  for (const r of rows) {
    const num = normNum(r[H.studentNumber]); if (!num) continue;
    const act = r[H.assignment];
    gb.set(`${num}|${act}`, { passed: +r[H.passed] || 0, total: +r[H.total] || 0, aiScore: r[H.aiScore], repo: r[H.repo] });
    if (!numActs.has(num)) numActs.set(num, new Set());
    numActs.get(num).add(act);
  }
}

// ---- Canvas roster -------------------------------------------------------
const users = await canvasGet(`/courses/${courseId}/users?enrollment_type[]=student&include[]=enrollments`);
const uidToNum = new Map(), numToUser = new Map();
for (const u of users) { const num = normNum(u.sis_user_id); uidToNum.set(u.id, num); if (num) numToUser.set(num, { uid: u.id, name: u.sortable_name || u.name }); }

// identity: gradebook number not on Canvas
for (const num of numActs.keys()) if (!numToUser.has(num)) F.identity.push({ num, acts: [...numActs.get(num)].length });
// enrolled on Canvas but zero graded work anywhere
for (const [num, u] of numToUser) if (!numActs.has(num)) F.noWork.push({ num, name: u.name });

// ---- map Canvas assignments -> our activities ----------------------------
const assignments = await canvasGet(`/courses/${courseId}/assignments`);
const mapped = assignments.map((a) => ({ a, ourId: tokenToId(a.name) })).filter((x) => x.ourId && policy.has(x.ourId));
const mappedActs = new Set(mapped.map((x) => x.ourId));
let gradedMapped = 0, gradedWithCanvas = 0;   // coverage over graded rows on mapped activities

for (const { a, ourId } of mapped) {
  const pol = policy.get(ourId) || {};
  const subs = await canvasGet(`/courses/${courseId}/assignments/${a.id}/submissions`);
  for (const s of subs) {
    const num = uidToNum.get(s.user_id); if (!num) continue;
    // coverage: does Canvas hold a grade for a repo we graded on a mapped activity?
    {
      const gg = gb.get(`${num}|${ourId}`);
      if (gg && gg.total > 0) {
        gradedMapped++;
        if (s.score != null) gradedWithCanvas++;
        else F.noCanvasGrade.push({ num, act: ourId, kind: (pol.aiGraded || pol.manual) ? (pol.publish ? "held-published?" : "held-for-review (expected)") : "GAP-deterministic" });
      }
    }
    const submitted = !!s.submitted_at;   // a real student submission (not a teacher-typed score)
    const g = gb.get(`${num}|${ourId}`);
    const has = g && g.total > 0;
    if (has && !submitted) F.gradedNotSubmitted.push({ num, act: ourId, ourScore: `${g.passed}/${g.total}` });
    if (submitted && !has) F.submittedNotGraded.push({ num, act: ourId, repo: g?.repo || "(no repo/blank grade)" });
    // readability: only for actual file uploads (the screenshots we must read)
    if (submitted && s.submission_type === "online_upload") {
      const atts = s.attachments || [];
      const good = atts.some((x) => isImage(x) && (x.size == null || x.size > 0));
      if (!good) F.unreadable.push({ num, act: ourId, why: atts.length ? `not a readable image (${atts.map((x) => x.filename).join(", ")})` : "upload with no file" });
    }
    // agreement (deterministic only; AI/manual are reviewed, not compared)
    if (has && submitted && !pol.aiGraded && !pol.manual && s.score != null) {
      const ours = pointsFor({ passed: g.passed, total: g.total }, { autoPoints: pol.autoPoints, pointsPossible: a.points_possible });
      if (ours != null && Math.abs(ours - s.score) > 0.5) F.disagree.push({ num, act: ourId, ours, canvas: s.score });
    }
  }
}
// coverage over ALL graded rows: how many are on an activity with a Canvas
// assignment, and of those, how many actually carry a Canvas grade.
let gradedTotal = 0, gradedOnMapped = 0;
for (const [k, g] of gb) { if (g.total > 0) { gradedTotal++; if (mappedActs.has(k.split("|")[1])) gradedOnMapped++; } }
F.coverage = { gradedTotal, gradedOnMapped, gradedNoCanvasAssignment: gradedTotal - gradedOnMapped, gradedWithCanvasGrade: gradedWithCanvas, gradedNoCanvasGrade: gradedMapped - gradedWithCanvas };

writeReport();
console.error(oneLine());

// ---- reporting -----------------------------------------------------------
function oneLine() {
  const n = (k) => (F[k] || []).length;
  const gap = (F.noCanvasGrade || []).filter((x) => x.kind === "GAP-deterministic").length;
  const c = F.coverage;
  const cov = c ? ` | COVERAGE graded-with-canvas-grade ${c.gradedWithCanvasGrade}/${c.gradedOnMapped} (det-gap ${gap}, no-canvas-assignment ${c.gradedNoCanvasAssignment})` : "";
  return `${section || "?"}: canvas | id-mismatch ${n("identity")} | disagree ${n("disagree")} | unreadable ${n("unreadable")}${cov}`;
}
function tbl(rows, cols) {
  if (!rows.length) return ["_none_", ""];
  return ["| " + cols.join(" | ") + " |", "| " + cols.map(() => "---").join(" | ") + " |",
    ...rows.map((r) => "| " + cols.map((c) => r[c] ?? "").join(" | ") + " |"), ""];
}
function writeReport() {
  const L = [`# Canvas cross-check - section ${section || "(unknown)"}`, "", `Generated against ${BASE} (course ${courseId}). Read-only against Canvas.`, ""];
  const c = F.coverage;
  if (c) L.push("## Coverage: every graded repo -> a Canvas grade?", "",
    `- Graded rows on an activity WITH a Canvas assignment: **${c.gradedOnMapped}**`,
    `- ...of those, actually carry a Canvas grade: **${c.gradedWithCanvasGrade}**`,
    `- Graded rows whose activity has NO Canvas assignment: **${c.gradedNoCanvasAssignment}**`, "");
  L.push("## Graded here but NO Canvas grade (deterministic = real gap; held = expected AI/manual)", "", ...tbl(F.noCanvasGrade, ["num", "act", "kind"]));
  L.push("## Gradebook student number NOT on Canvas roster (fix student.json / roster)", "", ...tbl(F.identity, ["num", "acts"]));
  L.push("## Graded here but NO Canvas submission (student did not submit on Canvas?)", "", ...tbl(F.gradedNotSubmitted, ["num", "act", "ourScore"]));
  L.push("## Submitted on Canvas but NOT graded (missing/empty/misnamed repo -> investigate)", "", ...tbl(F.submittedNotGraded, ["num", "act", "repo"]));
  L.push("## Canvas submission NOT readable by the system (missing/non-image attachment)", "", ...tbl(F.unreadable, ["num", "act", "why"]));
  L.push("## Score disagreement, gradebook vs Canvas (deterministic activities only)", "", ...tbl(F.disagree, ["num", "act", "ours", "canvas"]));
  L.push("## Enrolled on Canvas but zero graded work (non-submitter?)", "", ...tbl(F.noWork, ["num", "name"]));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, L.join("\n"));
}
