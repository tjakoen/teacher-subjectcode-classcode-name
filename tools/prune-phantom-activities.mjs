#!/usr/bin/env node
// Remove PHANTOM activities (no Canvas assignment AND no gradebook rows) from
// THIS section's grader/assignments.json. Line-based edit preserves formatting;
// the result is JSON-validated before writing. DRY RUN by default; --execute
// writes the file. Output: reports/prune-phantom-activities.md.
//
// Usage:
//   node tools/prune-phantom-activities.mjs [--section=<code>] [--course=<id>]
//                                           [--execute] [--report=<path>]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tokenToId, parseCsv } from "./lib/gradebook.mjs";

const arg = (name, def = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const section = arg("section") || process.env.SECTION || "";
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const reportPath = arg("report", "reports/prune-phantom-activities.md");
const EXECUTE = flag("execute");
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID"); process.exit(1); }

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

const path = "grader/assignments.json";
const acts = JSON.parse(readFileSync(path, "utf8"));
const canvas = await canvasGet(`/courses/${courseId}/assignments`);
const cIds = new Set(canvas.map((a) => tokenToId(a.name)).filter(Boolean));
const gc = {};
if (existsSync("gradebook/grades.csv")) {
  const rows = parseCsv(readFileSync("gradebook/grades.csv", "utf8"));
  const H = rows.shift().reduce((m, h, i) => ((m[h] = i), m), {});
  for (const r of rows) gc[r[H.assignment]] = (gc[r[H.assignment]] || 0) + 1;
}
const drop = new Set(acts.filter((a) => !cIds.has(a.id) && !gc[a.id]).map((a) => a.id));

// line-based edit preserves the compact one-object-per-line formatting
const src = readFileSync(path, "utf8");
const kept = src.split("\n").filter((line) => { const m = line.match(/"id"\s*:\s*"([^"]+)"/); return !(m && drop.has(m[1])); });
const out = kept.join("\n").replace(/,(\s*)\]/, "$1]");   // no trailing comma on the last element
const parsed = JSON.parse(out);                           // validate before writing

const L = [`# Phantom activity prune - section ${section || "(unknown)"}`, "", EXECUTE ? "MODE: EXECUTE" : "MODE: dry-run", "",
  `Activities: **${acts.length}** -> **${parsed.length}** (removed ${drop.size})`, ""];
if (drop.size) { L.push("Removed (no Canvas assignment AND no gradebook rows):", ""); for (const id of drop) L.push(`- ${id}`); L.push(""); }
else L.push("_No phantom activities. Nothing to prune._", "");

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, L.join("\n"));
if (EXECUTE && drop.size) { writeFileSync(path, out); console.error(`wrote ${path}`); }
console.error(`${section}: ${acts.length} -> ${parsed.length} (removed ${[...drop].join(", ") || "none"})`);
