#!/usr/bin/env node
// Set an activity's due / available-from / available-until dates in Canvas.
//
// canvas-sync-assignments.mjs authors an assignment's name, description, points
// and submission type, and deliberately NEVER touches due_at or published: those
// are the two things a human decides. This is that human decision, made over the
// API for when the Canvas UI is not reachable. It changes dates only, never
// points, never the description, never published.
//
// DRY RUN BY DEFAULT: prints the current dates and the planned change, and
// writes nothing until --execute. Reads every date back from Canvas afterwards.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-assignment-dates.mjs --only=m5a2,m5a3 \
//     --due="2026-08-10 23:59" --until="2026-08-11 23:59" [--from=<when>] --execute
//
// Options:
//   --only=<ids>   REQUIRED. Comma-separated activity ids to move.
//   --due=<when>   due_at        (or "none" to clear)
//   --until=<when> lock_at       (or "none" to clear)
//   --from=<when>  unlock_at     (or "none" to clear)
//   --tz=<offset>  offset for times written without one (default +08:00)
//   --execute      actually write; otherwise dry run
//
// A time of exactly 00:00 is REFUSED: Canvas rewrites midnight to 23:59:59 of
// the same day, moving a deadline by a whole day. Write 23:59 and mean it.
//
// REOPENING IS NOT FREE. Moving a due date later un-marks submissions that were
// flagged late, and a lock date in the future lets students submit work that
// nothing will re-grade until the next sweep. The dry run prints both effects.

import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const execute = process.argv.includes("--execute");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const only = (arg("only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const TZ = arg("tz", "+08:00");

if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!only.length) { console.error("--only is required: name the activities to move, e.g. --only=m5a2,m5a3"); process.exit(1); }
if (!/^[+-]\d{2}:\d{2}$/.test(TZ)) { console.error(`--tz must look like +08:00, got ${TZ}`); process.exit(1); }

const normalizeDate = (input, label) => {
  if (input == null) return undefined;
  if (input === "none" || input === "null" || input === "") return null;
  if (input === "now") return new Date().toISOString();
  let s = String(input).trim().replace(" ", "T");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!/T\d{2}:\d{2}/.test(s)) s += "T00:00";
  if (!/T\d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(/(T\d{2}:\d{2})/, "$1:00");
  const local = hasOffset ? s : s + TZ;
  if ((local.match(/T(\d{2}:\d{2}:\d{2})/) || [])[1] === "00:00:00") {
    console.error(`${label}: refusing the time 00:00. Canvas rewrites midnight to 23:59:59 of the SAME day,`);
    console.error(`  which moves the boundary by a day without telling you. Write the end of a day as 23:59.`);
    process.exit(1);
  }
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) { console.error(`${label}: cannot parse the date ${input}`); process.exit(1); }
  return d.toISOString();
};

// Compare INSTANTS, not strings: Canvas echoes "2026-08-10T15:59:00Z" while
// toISOString() produces "2026-08-10T15:59:00.000Z". Identical moments, and a
// string compare calls them drift.
const sameInstant = (a, b) => {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  return Number.isNaN(ta) || Number.isNaN(tb) ? String(a) === String(b) : ta === tb;
};

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

const due = normalizeDate(arg("due"), "--due");
const until = normalizeDate(arg("until"), "--until");
const from = normalizeDate(arg("from"), "--from");
if (due === undefined && until === undefined && from === undefined) {
  console.error("nothing to change: pass at least one of --due, --until, --from");
  process.exit(1);
}
if (due && until && new Date(due) > new Date(until)) {
  console.error(`\n--due (${inTz(due)}) is after --until (${inTz(until)}), so it could never be met on time. Refusing.`);
  process.exit(1);
}

(async () => {
  console.log(`Assignment dates -> Canvas course ${courseId}  (${execute ? "EXECUTE" : "DRY RUN"})  [dates in ${TZ}]`);

  const assignments = await apiGetAll(`/courses/${courseId}/assignments`);
  const targets = assignments.filter((a) => only.includes(tokenToId(a.name) || ""));
  const missing = only.filter((id) => !targets.some((a) => tokenToId(a.name) === id));
  if (missing.length) console.log(`  NOT IN CANVAS: ${missing.join(", ")}`);
  if (!targets.length) { console.error("\nnone of the named activities exist in this course."); process.exit(1); }

  const want = {};
  if (due !== undefined) want.due_at = due;
  if (until !== undefined) want.lock_at = until;
  if (from !== undefined) want.unlock_at = from;

  for (const a of targets) {
    const id = tokenToId(a.name);
    console.log(`\n  ${id} ("${a.name}", assignment ${a.id}, ${a.published ? "published" : "UNPUBLISHED"})`);
    for (const [k, v] of Object.entries(want)) {
      const same = sameInstant(a[k], v);
      console.log(`    ${k.padEnd(10)} ${inTz(a[k]).padEnd(17)} ${same ? "=  (no change)" : "->  " + inTz(v)}`);
    }

    // Reopening has consequences worth seeing before the write, not after.
    const subs = await apiGetAll(`/courses/${courseId}/assignments/${a.id}/submissions`);
    const late = subs.filter((s) => s.late).length;
    const graded = subs.filter((s) => s.workflow_state === "graded" && s.score != null).length;
    const submitted = subs.filter((s) => s.submitted_at).length;
    console.log(`    now: ${submitted} submitted, ${graded} graded, ${late} flagged late`);
    if (late && due && targets.length) {
      const stillLate = subs.filter((s) => s.submitted_at && new Date(s.submitted_at) > new Date(due)).length;
      if (stillLate < late) console.log(`    moving the due date un-flags ${late - stillLate} of those ${late} late submissions`);
    }
    if (until && new Date(until) > new Date() && graded) {
      console.log(`    NOTE: ${graded} already have a score; new submissions after this will not be re-graded until the next sweep`);
    }
  }

  if (!execute) {
    console.log("\nDRY RUN - nothing written. Re-run with --execute to apply.");
    process.exit(0);
  }

  console.log("\napplying...");
  let drift = 0;
  for (const a of targets) {
    await apiJson(`/courses/${courseId}/assignments/${a.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignment: want }),
    });
    const back = await apiJson(`/courses/${courseId}/assignments/${a.id}`);
    const id = tokenToId(a.name);
    for (const k of Object.keys(want)) {
      const ok = sameInstant(back[k], want[k]);
      if (!ok) drift++;
      console.log(`  ${ok ? "ok  " : "DRIFT"} ${id} ${k.padEnd(10)} ${inTz(back[k])}${ok ? "" : `   (asked for ${inTz(want[k])})`}`);
    }
  }
  if (drift) { console.log(`\n${drift} date(s) came back different from what was asked.`); process.exit(2); }
  console.log("\nAll dates stored as asked.");
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
