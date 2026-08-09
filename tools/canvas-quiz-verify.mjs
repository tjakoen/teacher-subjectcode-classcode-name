#!/usr/bin/env node
// Compare the quiz Canvas actually stored against quizzes/<q>/quiz.json.
//
// READ-ONLY. The QTI round trip (build -> zip -> Content Migrations -> Canvas's
// own importer) has several places where an item can arrive subtly wrong: a
// choice dropped, the wrong option marked correct, a fill-in-the-blank losing
// its alternate spellings, an item silently becoming an essay question. None of
// that is visible from the import log, which only reports "completed". This
// checks the result question by question, so a quiz can be trusted without
// opening the Canvas UI.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-quiz-verify.mjs <quizId> [--course=<id>] [--verbose]
//
// Exit status: 0 when everything matches, 1 on any mismatch.

import fs from "node:fs";
import path from "node:path";
import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const verbose = process.argv.includes("--verbose");
const positional = process.argv.slice(2).find((x) => !x.startsWith("--"));
const quizId = positional || arg("quiz");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";

if (!quizId) { console.error("usage: canvas-quiz-verify.mjs <quizId> [--course=<id>]"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }

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

// Canvas stores question text as HTML and normalizes entities and whitespace.
// Compare on the visible text only.
const plain = (s) =>
  String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const TYPE = { multiple_choice: "multiple_choice_question", short_answer: "short_answer_question" };

const srcPath = path.join("quizzes", quizId, "quiz.json");
if (!fs.existsSync(srcPath)) { console.error(`source not found: ${srcPath}`); process.exit(1); }
const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));

(async () => {
  console.log(`Quiz verify: ${quizId} vs Canvas course ${courseId} (read-only)`);

  const quizzes = await apiGetAll(`/courses/${courseId}/quizzes`);
  const matches = quizzes.filter((q) => tokenToId(q.title) === quizId || q.title === src.title);
  if (!matches.length) { console.error(`\nnot found in Canvas: nothing matching "${quizId}"`); process.exit(1); }
  if (matches.length > 1) {
    console.error(`\nAMBIGUOUS: ${matches.length} copies in Canvas (${matches.map((q) => q.id).join(", ")}). Delete the duplicates first.`);
    process.exit(1);
  }
  const quiz = matches[0];
  const questions = await apiGetAll(`/courses/${courseId}/quizzes/${quiz.id}/questions`);

  const problems = [];
  const expectPts = src.questions.length * src.pointsPerQuestion;

  console.log(`\nCanvas quiz id ${quiz.id}  "${quiz.title}"`);
  console.log(`  engine          : ${quiz.quiz_type}`);
  console.log(`  published       : ${quiz.published}`);
  console.log(`  questions       : ${questions.length} (source has ${src.questions.length})`);
  console.log(`  points possible : ${quiz.points_possible} (source implies ${expectPts})`);
  if (questions.length !== src.questions.length) problems.push(`question count ${questions.length} != ${src.questions.length}`);
  if (Number(quiz.points_possible) !== expectPts) problems.push(`points ${quiz.points_possible} != ${expectPts}`);

  const unmatched = [...questions];
  console.log("");
  for (const q of src.questions) {
    const stem = plain(q.text);
    const idx = unmatched.findIndex((c) => plain(c.question_text).includes(stem));
    if (idx < 0) {
      problems.push(`${q.id}: no Canvas question carries this stem`);
      console.log(`  ${q.id.padEnd(4)} MISSING   ${stem.slice(0, 70)}`);
      continue;
    }
    const c = unmatched.splice(idx, 1)[0];
    const issues = [];

    if (c.question_type !== TYPE[q.type || "short_answer"]) {
      issues.push(`type ${c.question_type} (wanted ${TYPE[q.type || "short_answer"]})`);
    }
    if (Number(c.points_possible) !== src.pointsPerQuestion) {
      issues.push(`${c.points_possible} pts (wanted ${src.pointsPerQuestion})`);
    }
    if (q.code && !plain(c.question_text).includes(plain(q.code).slice(0, 30))) {
      issues.push("code block missing from the stem");
    }

    const got = (c.answers || []).map((a) => ({ text: plain(a.text), correct: Number(a.weight) === 100 }));
    if (q.type === "multiple_choice") {
      const wantChoices = q.choices.map(plain).sort();
      const gotChoices = got.map((a) => a.text).sort();
      if (JSON.stringify(wantChoices) !== JSON.stringify(gotChoices)) {
        issues.push(`choices differ (Canvas has ${got.length})`);
      }
      const correct = got.filter((a) => a.correct).map((a) => a.text);
      const wantCorrect = q.answers.map(plain);
      if (correct.length !== wantCorrect.length || correct.some((t) => !wantCorrect.includes(t))) {
        issues.push(`correct option is ${JSON.stringify(correct)} (wanted ${JSON.stringify(wantCorrect)})`);
      }
    } else {
      const want = q.answers.map((a) => plain(a).toLowerCase()).sort();
      const gotSet = got.map((a) => a.text.toLowerCase()).sort();
      if (JSON.stringify(want) !== JSON.stringify(gotSet)) {
        issues.push(`accepted answers ${JSON.stringify(gotSet)} (wanted ${JSON.stringify(want)})`);
      }
      if (got.some((a) => !a.correct)) issues.push("an accepted spelling is not weighted as correct");
    }

    if (issues.length) {
      problems.push(`${q.id}: ${issues.join("; ")}`);
      console.log(`  ${q.id.padEnd(4)} MISMATCH  ${issues.join("; ")}`);
    } else if (verbose) {
      console.log(`  ${q.id.padEnd(4)} ok        ${stem.slice(0, 66)}`);
    }
  }

  for (const extra of unmatched) {
    problems.push(`extra Canvas question not in the source: "${plain(extra.question_text).slice(0, 60)}"`);
    console.log(`  ---- EXTRA     ${plain(extra.question_text).slice(0, 60)}`);
  }

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nAll ${src.questions.length} questions match the source: stems, types, points, choices and correct answers.`);
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
