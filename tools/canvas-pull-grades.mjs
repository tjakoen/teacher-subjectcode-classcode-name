#!/usr/bin/env node
// Pull an activity's grades back FROM Canvas into gradebook/grades.csv, for a
// unified local record. When an activity is graded IN Canvas - a manual/badge
// activity you score by hand in SpeedGrader, or a Canvas-native quiz - Canvas is
// the grade source. This reads each student's Canvas score for one assignment and
// upserts a gradebook row so GRADEBOOK.md and the local record stay complete.
//
// It is the general form of canvas-pull-quiz-grades: it resolves the Canvas
// assignment directly (by name -> our id via tokenToId), so it works for ANY
// activity, not just quizzes.
//
// READ-ONLY BY DEFAULT: prints the planned changes and writes nothing until
// --execute. Even with --execute it ONLY edits gradebook/grades.csv (never
// Canvas). It regenerates only the score-bearing columns of a matched row;
// identity columns (repo, github, name, number, email, classCode) are preserved
// from the existing row, or filled from the Canvas user when no row exists yet.
//
// Auth (same as canvas-push): CANVAS_BASE_URL, CANVAS_TOKEN, CANVAS_COURSE_ID (or --course=<id>).
//
// Usage: node tools/canvas-pull-grades.mjs <activityId> [--course=<id>] [--section=<code>] [--execute]

import fs from "node:fs";
import { parseCsvLine, csvField, normNum, normEmail, tokenToId } from "./lib/gradebook.mjs";

const CSV = "gradebook/grades.csv";

// Build the upserted CSV text from raw csv + a map of studentNumber -> new score
// data. Pure + offline (unit-testable): given the same inputs it returns the same
// text. Score-bearing columns only; identity is preserved or filled.
export function upsertGradeRows(csvText, activityId, section, scores) {
  const lines = csvText.replace(/\n$/, "").split("\n");
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const blank = () => header.map(() => "");
  const identityByNum = new Map();
  const rowByNum = new Map();
  const body = lines.slice(1).filter(Boolean).map(parseCsvLine);
  for (let i = 0; i < body.length; i++) {
    const f = body[i];
    const num = normNum(f[idx.studentNumber]);
    if (num && !identityByNum.has(num)) identityByNum.set(num, f);
    if (num && f[idx.assignment] === activityId) rowByNum.set(num, i);
  }
  let updated = 0, added = 0;
  const additions = [];
  for (const [num, sc] of scores) {
    const scoreCell = `${sc.passed}/${sc.total}`;
    const setScore = (f) => {
      f[idx.assignment] = activityId;
      f[idx.passed] = String(sc.passed);
      f[idx.total] = String(sc.total);
      if (idx.score != null) f[idx.score] = scoreCell;
      f[idx.gradedAt] = sc.gradedAt || f[idx.gradedAt] || "";
      f[idx.notes] = "pulled from Canvas";
      return f;
    };
    if (rowByNum.has(num)) { setScore(body[rowByNum.get(num)]); updated++; }
    else {
      const id = identityByNum.get(num);
      const f = blank();
      if (id) {
        f[idx.repo] = id[idx.repo] || `student-${section}-canvas-${num}`;
        f[idx.githubAccount] = id[idx.githubAccount] || "";
        f[idx.fullName] = id[idx.fullName] || sc.name || "";
        f[idx.studentEmail] = id[idx.studentEmail] || sc.email || "";
        f[idx.classCode] = id[idx.classCode] || section;
      } else {
        f[idx.repo] = `student-${section}-canvas-${num}`;
        f[idx.fullName] = sc.name || "";
        f[idx.studentEmail] = sc.email || "";
        f[idx.classCode] = section;
      }
      f[idx.studentNumber] = num;
      setScore(f);
      additions.push(f);
      added++;
    }
  }
  const all = [header, ...body, ...additions];
  return { text: all.map((f) => f.map(csvField).join(",")).join("\n") + "\n", updated, added };
}

if (process.argv[1] && process.argv[1].endsWith("canvas-pull-grades.mjs")) {
  const arg = (n, d = null) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a ? a.split("=").slice(1).join("=") : d;
  };
  const positional = process.argv.slice(2).find((x) => !x.startsWith("--"));
  const activityId = positional || arg("activity");
  const execute = process.argv.includes("--execute");
  const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
  const section = arg("section") || process.env.SECTION || "";
  const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
  const TOKEN = process.env.CANVAS_TOKEN || "";
  if (!activityId) { console.error("usage: canvas-pull-grades.mjs <activityId> [--course=<id>] [--execute]"); process.exit(1); }
  if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
  if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
  if (!fs.existsSync(CSV)) { console.error(`no ${CSV} - run a grade sweep first`); process.exit(1); }

  const api = async (p) => {
    const url = p.startsWith("http") ? p : `${BASE}/api/v1${p}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
    return res;
  };
  const apiGetAll = async (p) => {
    let url = `${BASE}/api/v1${p}${p.includes("?") ? "&" : "?"}per_page=100`;
    const out = [];
    while (url) {
      const res = await api(url);
      out.push(...(await res.json()));
      const next = (res.headers.get("link") || "").split(",").find((s) => s.includes('rel="next"'));
      url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
    }
    return out;
  };

  (async () => {
    const assignments = await apiGetAll(`/courses/${courseId}/assignments`);
    const assignment = assignments.find((a) => tokenToId(a.name) === activityId);
    if (!assignment) { console.error(`no Canvas assignment whose name maps to ${activityId} in course ${courseId}`); process.exit(1); }
    const pp = assignment.points_possible ?? 0;
    console.log(`Pull "${assignment.name}" (assignment ${assignment.id}, ${pp} pts) -> ${CSV}  (${execute ? "EXECUTE" : "DRY RUN"})`);

    const subs = await apiGetAll(`/courses/${courseId}/assignments/${assignment.id}/submissions?include[]=user`);
    const scores = new Map();
    let skipped = 0;
    for (const s of subs) {
      if (s.score == null || s.workflow_state === "unsubmitted") { skipped++; continue; }
      const u = s.user || {};
      const num = normNum(u.sis_user_id || "");
      if (!num) { skipped++; continue; }
      scores.set(num, {
        passed: s.score, total: pp,
        gradedAt: s.graded_at || s.submitted_at || "",
        name: u.sortable_name || u.name || "", email: normEmail(u.login_id || ""),
      });
    }
    console.log(`  ${scores.size} graded submission(s) with a student number; ${skipped} skipped (ungraded/no number).`);

    const res = upsertGradeRows(fs.readFileSync(CSV, "utf8"), activityId, section, scores);
    console.log(`  plan: update ${res.updated} existing ${activityId} row(s), add ${res.added} new row(s).`);
    if (!execute) { console.log("\nDRY RUN - nothing written. Re-run with --execute to update the gradebook."); process.exit(0); }
    fs.writeFileSync(CSV, res.text);
    console.log(`Wrote ${CSV}. Re-run the grade sweep (or dashboard build) to refresh GRADEBOOK.md / the review UI.`);
  })().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
