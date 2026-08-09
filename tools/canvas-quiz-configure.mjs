#!/usr/bin/env node
// Set an imported quiz's release settings in Canvas, and optionally publish it.
//
// canvas-quiz-import.mjs deliberately lands a quiz UNPUBLISHED with no dates, so
// you can review it first. Finishing the job normally means clicking through the
// Canvas UI. This does the same work over the API, for when the UI is not
// reachable, and it READS EVERY SETTING BACK afterwards so you can see what
// Canvas actually stored rather than what you asked for.
//
// DRY RUN BY DEFAULT: prints the current settings and the planned change, and
// writes nothing until --execute.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-quiz-configure.mjs <quizId> [options]
//   node tools/canvas-quiz-configure.mjs m4-canvas-quiz \
//     --unlock=now --lock="2026-08-10 23:59" --attempts=1 --shuffle \
//     --answers-after-lock --publish --execute
//
// Options:
//   --unlock=<when>        available from ("now", or a date; see TIMES below)
//   --lock=<when>          available until
//   --due=<when>           due date (defaults to --lock when omitted)
//   --attempts=<n>         allowed attempts (-1 for unlimited)
//   --time-limit=<min>     minutes; use 0 or "none" to clear the limit
//   --shuffle              shuffle the ANSWERS within each question
//   --one-at-a-time        show one question per page
//   --answers-after-lock   hold correct answers until the lock date
//   --publish              publish the quiz (students can see it)
//   --unpublish            unpublish (Canvas refuses once there are submissions)
//   --tz=<offset>          offset for times written without one (default +08:00)
//   --execute              actually write; otherwise dry run
//
// TIMES: pass either a full offset form ("2026-08-10T23:59:00+08:00") or a plain
// local time ("2026-08-10 23:59"), which is read in --tz. A time of exactly
// 00:00 is REFUSED: Canvas silently rewrites midnight to 23:59:59 of the same
// day, which quietly moves a deadline by a whole day. Write 23:59 and mean it.

import fs from "node:fs";
import path from "node:path";
import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const positional = process.argv.slice(2).find((x) => !x.startsWith("--"));
const quizId = positional || arg("quiz");
const execute = has("execute");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const TZ = arg("tz", "+08:00");

if (!quizId) { console.error("usage: canvas-quiz-configure.mjs <quizId> [options] [--execute]"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!/^[+-]\d{2}:\d{2}$/.test(TZ)) { console.error(`--tz must look like +08:00, got ${TZ}`); process.exit(1); }

// A local wall-clock time plus an explicit offset, so Canvas never has to guess.
const normalizeDate = (input, label) => {
  if (input == null) return undefined;
  if (input === "" || input === "none" || input === "null") return null;
  if (input === "now") return new Date().toISOString();
  let s = String(input).trim().replace(" ", "T");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!/T\d{2}:\d{2}/.test(s)) s += "T00:00";
  if (!/T\d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(/(T\d{2}:\d{2})/, "$1:00");
  const local = hasOffset ? s : s + TZ;
  const hhmmss = (local.match(/T(\d{2}:\d{2}:\d{2})/) || [])[1];
  if (hhmmss === "00:00:00") {
    console.error(`${label}: refusing the time 00:00. Canvas rewrites midnight to 23:59:59 of the SAME day,`);
    console.error(`  which moves the boundary by a day without telling you. Write the end of a day as 23:59.`);
    process.exit(1);
  }
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) { console.error(`${label}: cannot parse the date ${input}`); process.exit(1); }
  return d.toISOString();
};

// Render a UTC instant back in the course's offset, for human-checkable output.
const inTz = (iso) => {
  if (!iso) return String(iso);
  const sign = TZ.startsWith("-") ? -1 : 1;
  const [h, m] = TZ.slice(1).split(":").map(Number);
  const shifted = new Date(new Date(iso).getTime() + sign * (h * 60 + m) * 60000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, "") + TZ;
};

const api = async (p, init = {}) => {
  const url = p.startsWith("http") ? p : `${BASE}/api/v1${p}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}\n${await res.text().catch(() => "")}`);
  return res;
};
const apiJson = async (p, init) => (await api(p, init)).json();
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

const srcPath = path.join("quizzes", quizId, "quiz.json");
const src = fs.existsSync(srcPath) ? JSON.parse(fs.readFileSync(srcPath, "utf8")) : { id: quizId, title: quizId };

(async () => {
  console.log(`Quiz configure: ${quizId} -> Canvas course ${courseId}  (${execute ? "EXECUTE" : "DRY RUN"})`);

  // Parse and validate every date BEFORE touching the network, so a bad time
  // (or a midnight) fails instantly instead of after a round trip.
  const unlock = normalizeDate(arg("unlock"), "--unlock");
  const lock = normalizeDate(arg("lock"), "--lock");
  const dueRaw = arg("due");
  const due = dueRaw != null ? normalizeDate(dueRaw, "--due") : lock;
  if (unlock && lock && new Date(unlock) >= new Date(lock)) {
    console.error(`\n--unlock (${inTz(unlock)}) is not before --lock (${inTz(lock)}). Refusing.`);
    process.exit(1);
  }
  if (has("answers-after-lock") && !lock) {
    console.error("\n--answers-after-lock needs --lock: there is no date to hold the answers until.");
    process.exit(1);
  }

  const quizzes = await apiGetAll(`/courses/${courseId}/quizzes`);
  const matches = quizzes.filter((q) => tokenToId(q.title) === quizId || q.title === src.title);
  if (!matches.length) {
    console.error(`\nNot found in Canvas: no quiz whose title maps to "${quizId}".`);
    console.error(`  import it first: node tools/canvas-quiz-import.mjs ${quizId} --execute`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`\nAMBIGUOUS: ${matches.length} quizzes in this course match "${quizId}":`);
    for (const q of matches) console.error(`  id ${q.id}  "${q.title}"  ${q.published ? "published" : "unpublished"}`);
    console.error("  a duplicate import is the usual cause. Delete the extra copy in Canvas, then re-run.");
    process.exit(1);
  }
  const quiz = matches[0];

  const attempts = arg("attempts") != null ? Number(arg("attempts")) : undefined;
  const timeLimitRaw = arg("time-limit");
  const timeLimit = timeLimitRaw == null ? undefined
    : (timeLimitRaw === "none" || Number(timeLimitRaw) === 0 ? null : Number(timeLimitRaw));

  const want = {};
  if (unlock !== undefined) want.unlock_at = unlock;
  if (lock !== undefined) want.lock_at = lock;
  if (due !== undefined) want.due_at = due;
  if (attempts !== undefined) want.allowed_attempts = attempts;
  if (timeLimit !== undefined) want.time_limit = timeLimit;
  if (has("shuffle")) want.shuffle_answers = true;
  if (has("one-at-a-time")) want.one_question_at_a_time = true;
  if (has("answers-after-lock")) {
    want.hide_results = null;
    want.show_correct_answers = true;
    want.show_correct_answers_at = lock;
  }
  if (has("publish")) want.published = true;
  if (has("unpublish")) want.published = false;

  if (!Object.keys(want).length) { console.error("\nnothing to change: pass at least one option."); process.exit(1); }

  const show = (k, v) => (k.endsWith("_at") ? inTz(v) : String(v));
  console.log(`\nQuiz "${quiz.title}" (id ${quiz.id}, ${quiz.published ? "published" : "unpublished"}, ${quiz.quiz_type}, ${quiz.question_count} questions, ${quiz.points_possible} pts)`);
  console.log("\n  setting                   current                        ->  planned");
  for (const [k, v] of Object.entries(want)) {
    const before = quiz[k] === undefined ? "(unset)" : show(k, quiz[k]);
    const after = show(k, v);
    const same = String(before) === String(after);
    console.log(`  ${k.padEnd(24)}  ${String(before).padEnd(28)}  ${same ? "=  (no change)" : "->  " + after}`);
  }

  if (!execute) {
    console.log("\nDRY RUN - nothing written. Re-run with --execute to apply.");
    process.exit(0);
  }

  console.log("\napplying...");
  await apiJson(`/courses/${courseId}/quizzes/${quiz.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quiz: want }),
  });

  // Read back: Canvas silently normalizes some of these, so trust only this.
  const after = await apiJson(`/courses/${courseId}/quizzes/${quiz.id}`);
  console.log("\nStored by Canvas (read back, not echoed):");
  let drift = 0;
  for (const k of Object.keys(want)) {
    const got = after[k] === undefined ? "(unset)" : show(k, after[k]);
    const asked = show(k, want[k]);
    const ok = String(got) === String(asked);
    if (!ok) drift++;
    console.log(`  ${ok ? "ok  " : "DRIFT"} ${k.padEnd(24)} ${got}${ok ? "" : `   (asked for ${asked})`}`);
  }
  console.log(`\n  published      : ${after.published}`);
  console.log(`  engine         : ${after.quiz_type}`);
  console.log(`  questions/points: ${after.question_count} / ${after.points_possible}`);
  console.log(`  student URL    : ${after.html_url}`);
  if (drift) {
    console.log(`\n${drift} setting(s) came back different from what was asked. Canvas rewrote them; check the list above.`);
    process.exit(2);
  }
  console.log("\nAll requested settings stored as asked.");
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
