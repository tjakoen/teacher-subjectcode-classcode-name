#!/usr/bin/env node
// Import a quiz's repo-owned QTI package into Canvas via Content Migrations.
//
// One-way CONTENT import: students take the quiz IN Canvas, which hosts and
// auto-grades it. This uploads quizzes/<q>/canvas/<q>-qti.zip (built by
// build-quiz-qti.mjs from the quiz.json SSOT) as a qti_converter migration. That
// path imports into BOTH Classic and New Quizzes, so it does not depend on which
// engine the Canvas instance uses. The imported quiz stays UNPUBLISHED so you
// review it before releasing.
//
// DRY RUN BY DEFAULT: prints the plan and the existence check, uploads nothing
// until --execute.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-quiz-import.mjs <quizId> [--course=<id>] [--execute] [--force]
//   node tools/canvas-quiz-import.mjs q1 --execute
//
// --force re-imports even if a quiz with this id/title already exists in Canvas
// (Canvas would create a duplicate; default is to skip and tell you).

import fs from "node:fs";
import path from "node:path";
import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const positional = process.argv.slice(2).find((x) => !x.startsWith("--"));
const quizId = positional || arg("quiz");
const execute = process.argv.includes("--execute");
const force = process.argv.includes("--force");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";

if (!quizId) { console.error("usage: canvas-quiz-import.mjs <quizId> [--course=<id>] [--execute]"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }

const srcPath = path.join("quizzes", quizId, "quiz.json");
const zipPath = path.join("quizzes", quizId, "canvas", `${quizId}-qti.zip`);
if (!fs.existsSync(zipPath)) {
  console.error(`QTI zip not found: ${zipPath}\n  run: node tools/build-quiz-qti.mjs ${quizId}`);
  process.exit(1);
}
const quiz = fs.existsSync(srcPath) ? JSON.parse(fs.readFileSync(srcPath, "utf8")) : { id: quizId, title: quizId };
const zipBuf = fs.readFileSync(zipPath);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`Quiz import: ${quizId} ("${quiz.title || quizId}") -> Canvas course ${courseId}  (${execute ? "EXECUTE" : "DRY RUN"})`);
  console.log(`  package: ${zipPath} (${zipBuf.length} bytes)`);

  // Existence check: is a quiz with this id/title already in the course?
  const quizzes = await apiGetAll(`/courses/${courseId}/quizzes`);
  const hit = quizzes.find((q) => tokenToId(q.title) === quizId || q.title === quiz.title);
  if (hit) {
    console.log(`  EXISTS in Canvas: "${hit.title}" (quiz id ${hit.id}, ${hit.published ? "published" : "unpublished"})`);
    if (!force) {
      console.log("  -> skipping to avoid a duplicate. Re-run with --force to import anyway.");
      process.exit(0);
    }
    console.log("  --force set: importing anyway (Canvas will create a second copy).");
  } else {
    console.log("  not yet in Canvas.");
  }

  if (!execute) {
    console.log("\nDRY RUN - nothing uploaded. Re-run with --execute to import.");
    console.log("The imported quiz will be created UNPUBLISHED for your review.");
    process.exit(0);
  }

  // 1. Create the content migration with a pre_attachment (Canvas file-upload handshake).
  console.log("\n1/3 creating content migration (qti_converter)...");
  const mig = await apiJson(`/courses/${courseId}/content_migrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      migration_type: "qti_converter",
      pre_attachment: { name: `${quizId}-qti.zip`, size: zipBuf.length },
      // Leave the Classic/New Quizzes choice to the Canvas account default. To
      // force New Quizzes, add settings: { import_quizzes_next: true }.
    }),
  });
  const up = mig.pre_attachment;
  if (!up || !up.upload_url) throw new Error(`no upload target in migration response: ${JSON.stringify(mig)}`);

  // 2. Upload the zip to the returned target (params first, file field last).
  console.log("2/3 uploading QTI zip...");
  const form = new FormData();
  for (const [k, v] of Object.entries(up.upload_params || {})) form.append(k, v);
  form.append("file", new Blob([zipBuf], { type: "application/zip" }), `${quizId}-qti.zip`);
  const upRes = await fetch(up.upload_url, { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(120000) });
  if (upRes.status >= 400) throw new Error(`upload failed: ${upRes.status} ${await upRes.text().catch(() => "")}`);

  // 3. Poll the migration progress to completion.
  console.log("3/3 processing migration...");
  const progressUrl = mig.progress_url;
  let state = mig.workflow_state;
  for (let i = 0; i < 60 && !["completed", "failed"].includes(state); i++) {
    await sleep(3000);
    const prog = progressUrl ? await apiJson(progressUrl) : await apiJson(`/courses/${courseId}/content_migrations/${mig.id}`);
    state = prog.workflow_state;
    if (prog.completion != null) process.stdout.write(`\r  ${state} ${prog.completion}%   `);
  }
  process.stdout.write("\n");
  if (state === "failed") {
    const m = await apiJson(`/courses/${courseId}/content_migrations/${mig.id}`);
    throw new Error(`migration failed: ${JSON.stringify(m.migration_issues_count ?? m)}`);
  }

  const after = await apiGetAll(`/courses/${courseId}/quizzes`);
  const imported = after.find((q) => tokenToId(q.title) === quizId || q.title === quiz.title);
  console.log(`\nDone. Imported quiz: ${imported ? `"${imported.title}" (id ${imported.id}, ${imported.published ? "published" : "UNPUBLISHED"})` : "(check the course - not found by title match)"}`);
  console.log("Review it in Canvas, then publish when ready. Students take it in Canvas; Canvas auto-grades.");
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
