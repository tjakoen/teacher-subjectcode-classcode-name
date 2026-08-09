#!/usr/bin/env node
// What does a Canvas course actually have live, and has anyone submitted?
//
// READ-ONLY. Answers the question no other tool does: for each activity, is
// there a Canvas assignment, is it PUBLISHED, what is it worth, and how many
// students have submitted or been graded. The gradebook only knows what the
// sweep graded from repos, so it cannot see a Canvas assignment that students
// submitted to but nothing ever pulled back.
//
// Takes --course, so one repo's token can survey a sibling section's course
// (the instructor's token carries their teacher enrollments).
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-activity-status.mjs [--course=<id>] [--only=m5a1,m5a2]
//   node tools/canvas-activity-status.mjs --course=<sibling id> --only=m5a1,m5a2
//
// Without --only it reports every assignment whose name maps to one of our ids.
// Dates print in --tz (default +08:00, the course's local offset), because a
// deadline read in UTC is off by most of a day here.

import { tokenToId } from "./lib/gradebook.mjs";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const only = (arg("only") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const TZ = arg("tz", "+08:00");

// Canvas stores instants in UTC; a deadline read in UTC is off by most of a day
// in Manila, so every date prints in the course's offset.
const inTz = (iso) => {
  if (!iso) return "-";
  const sign = TZ.startsWith("-") ? -1 : 1;
  const [h, m] = TZ.slice(1).split(":").map(Number);
  const shifted = new Date(new Date(iso).getTime() + sign * (h * 60 + m) * 60000);
  return shifted.toISOString().replace(/T/, " ").replace(/:\d{2}\.\d{3}Z$/, "");
};

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

(async () => {
  const course = await (await api(`/courses/${courseId}`)).json();
  console.log(`Course ${courseId}: ${course.name} (${course.course_code})`);

  const students = await apiGetAll(`/courses/${courseId}/users?enrollment_type[]=student`);
  console.log(`  active students: ${students.length}`);

  const assignments = await apiGetAll(`/courses/${courseId}/assignments`);
  const rows = [];
  for (const a of assignments) {
    const ourId = tokenToId(a.name);
    if (!ourId) continue;
    if (only.length && !only.includes(ourId)) continue;
    rows.push({ ourId, a });
  }
  rows.sort((x, y) => x.ourId.localeCompare(y.ourId, undefined, { numeric: true }));

  if (!rows.length) {
    console.log(only.length ? `\n  no Canvas assignment matches ${only.join(", ")}` : "\n  no Canvas assignment maps to one of our ids");
    return;
  }

  console.log(`\n  (dates in ${TZ})`);
  console.log("  id     pub    pts   sub  grd  due               available until   name");
  const late = [];
  for (const { ourId, a } of rows) {
    // A submission row exists for every student; only some are real attempts.
    const subs = await apiGetAll(`/courses/${courseId}/assignments/${a.id}/submissions`);
    const submitted = subs.filter((s) => s.workflow_state !== "unsubmitted" && s.submitted_at).length;
    const graded = subs.filter((s) => s.workflow_state === "graded" && s.score != null).length;
    if (subs.some((s) => s.late)) late.push(`${ourId}: ${subs.filter((s) => s.late).length} late`);
    console.log(
      `  ${ourId.padEnd(6)} ${String(a.published).padEnd(6)} ${String(a.points_possible ?? "-").padEnd(5)} ` +
      `${String(submitted).padEnd(4)} ${String(graded).padEnd(4)} ${inTz(a.due_at).padEnd(17)} ${inTz(a.lock_at).padEnd(17)} ${a.name}`
    );
  }
  if (late.length) console.log(`\n  late submissions: ${late.join(", ")}`);

  if (only.length) {
    const found = new Set(rows.map((r) => r.ourId));
    const missing = only.filter((id) => !found.has(id));
    if (missing.length) console.log(`\n  NOT IN CANVAS AT ALL: ${missing.join(", ")}`);
  }
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
