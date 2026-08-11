#!/usr/bin/env node
// Publish (or unpublish) an activity's Canvas assignment.
//
// canvas-sync-assignments.mjs authors an assignment's name, description, points
// and submission type, and always creates it UNPUBLISHED. canvas-assignment-dates.mjs
// sets its dates. Neither one ever flips `published`, because making work visible
// to a class is a decision, not a sync. This is that decision, made over the API
// for when the Canvas UI is not reachable. It changes `published` only: never
// points, never dates, never the description.
//
// DRY RUN BY DEFAULT: prints each assignment's current state, its dates, and what
// students would see the moment it goes live. Writes nothing until --execute, and
// reads the flag back from Canvas afterwards.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-assignment-publish.mjs --only=m7a1,m7a2,m7a3,m7a4 --execute
//   node tools/canvas-assignment-publish.mjs --only=m7a4 --unpublish --execute
//
// Options:
//   --only=<ids>   REQUIRED. Comma-separated activity ids.
//   --unpublish    hide it again instead of publishing.
//   --tz=<offset>  offset used to print dates (default +08:00)
//   --execute      actually write; otherwise dry run
//
// PUBLISHING IS VISIBLE AND NOTIFIED. The moment this runs, the assignment appears
// on the students' assignment list and to-do, and Canvas may email an "assignment
// created" notification to everyone in the course. There is no quiet publish, so
// check the dates in the dry run first: an assignment with no unlock_at is open
// the instant it is published, and one whose lock_at has already passed is visible
// but unsubmittable, which reads to a student as a missing grade.
//
// UNPUBLISHING IS NOT A SAFE UNDO. Canvas refuses to unpublish an assignment that
// has student submissions, and unpublishing one that only has grades hides those
// grades from the students who earned them. This tool refuses first, with a count,
// rather than letting the API decide.

import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const execute = process.argv.includes("--execute");
const unpublish = process.argv.includes("--unpublish");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const only = (arg("only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const TZ = arg("tz", "+08:00");

if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!only.length) { console.error("--only is required: name the activities, e.g. --only=m7a1,m7a2"); process.exit(1); }
if (!/^[+-]\d{2}:\d{2}$/.test(TZ)) { console.error(`--tz must look like +08:00, got ${TZ}`); process.exit(1); }

const inTz = (iso) => {
  if (!iso) return "(none)";
  const sign = TZ.startsWith("-") ? -1 : 1;
  const [h, m] = TZ.slice(1).split(":").map(Number);
  const shifted = new Date(new Date(iso).getTime() + sign * (h * 60 + m) * 60000);
  return shifted.toISOString().replace(/T/, " ").replace(/:\d{2}\.\d{3}Z$/, "");
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

const want = !unpublish;

(async () => {
  console.log(`Assignment ${want ? "publish" : "UNPUBLISH"} -> Canvas course ${courseId}  (${execute ? "EXECUTE" : "DRY RUN"})  [dates in ${TZ}]`);

  const assignments = await apiGetAll(`/courses/${courseId}/assignments`);
  const targets = assignments.filter((a) => only.includes(tokenToId(a.name) || ""));
  const missing = only.filter((id) => !targets.some((a) => tokenToId(a.name) === id));
  if (missing.length) console.log(`  NOT IN CANVAS: ${missing.join(", ")}  (run canvas-sync-assignments first)`);
  if (!targets.length) { console.error("\nnone of the named activities exist in this course."); process.exit(1); }

  const now = new Date();
  const todo = [];
  let refuse = 0;

  for (const a of targets) {
    const id = tokenToId(a.name);
    console.log(`\n  ${id} ("${a.name}", assignment ${a.id})`);
    console.log(`    published  ${a.published ? "yes" : "no"}${a.published === want ? "   =  (no change)" : `   ->  ${want ? "yes" : "no"}`}`);
    console.log(`    points     ${a.points_possible ?? "(none)"}`);
    console.log(`    unlock_at  ${inTz(a.unlock_at)}`);
    console.log(`    due_at     ${inTz(a.due_at)}`);
    console.log(`    lock_at    ${inTz(a.lock_at)}`);

    const subs = await apiGetAll(`/courses/${courseId}/assignments/${a.id}/submissions`);
    const submitted = subs.filter((s) => s.submitted_at).length;
    const graded = subs.filter((s) => s.workflow_state === "graded" && s.score != null).length;
    console.log(`    now: ${submitted} submitted, ${graded} graded`);

    if (a.published === want) continue;

    if (want) {
      // Publishing is what makes it real to the class, so say what "real" means here.
      if (!a.unlock_at) console.log(`    NOTE: no unlock date, so it opens to students the moment this runs`);
      else if (new Date(a.unlock_at) > now) console.log(`    ok: visible but locked until ${inTz(a.unlock_at)}`);
      if (a.lock_at && new Date(a.lock_at) < now) console.log(`    WARNING: lock_at has already passed, so students see it and cannot submit`);
      if (a.due_at && new Date(a.due_at) < now) console.log(`    WARNING: the due date is in the past, so every submission lands flagged late`);
      if (a.points_possible == null) console.log(`    WARNING: no points set; set them with canvas-sync-assignments before publishing`);
    } else if (submitted || graded) {
      console.log(`    REFUSING: ${submitted} submitted and ${graded} graded. Unpublishing hides delivered grades, and Canvas blocks it anyway.`);
      refuse++;
      continue;
    }
    todo.push(a);
  }

  if (refuse) { console.error(`\n${refuse} assignment(s) cannot be unpublished. Nothing was written.`); process.exit(1); }
  if (!todo.length) { console.log(`\nAll named assignments are already ${want ? "published" : "unpublished"}. Nothing to do.`); process.exit(0); }
  if (!execute) {
    console.log(`\nDRY RUN - nothing written. ${todo.length} would change. Re-run with --execute to apply.`);
    process.exit(0);
  }

  console.log("\napplying...");
  let drift = 0;
  for (const a of todo) {
    await apiJson(`/courses/${courseId}/assignments/${a.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignment: { published: want } }),
    });
    const back = await apiJson(`/courses/${courseId}/assignments/${a.id}`);
    const ok = back.published === want;
    if (!ok) drift++;
    console.log(`  ${ok ? "ok  " : "DRIFT"} ${tokenToId(a.name)} published=${back.published}${ok ? "" : `   (asked for ${want})`}`);
  }
  if (drift) { console.log(`\n${drift} assignment(s) came back different from what was asked.`); process.exit(2); }
  console.log(`\n${todo.length} assignment(s) now ${want ? "published" : "unpublished"}.`);
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
