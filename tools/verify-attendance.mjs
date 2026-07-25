#!/usr/bin/env node
// Verify + summarize the attendance batches the scanner commits.
//
// The scanner writes one CSV per scanning period ("batch"):
//   attendance/sessions/<YYYY-MM-DD>/<HHMM>-<label>.csv
// with rows  timestamp,studentNumber,signature. This tool (run by a workflow on
// every CSV push) recomputes the HMAC for each row with ATTENDANCE_HMAC_SECRET
// and marks it OK or FLAGGED, then writes:
//   - a per-date  <YYYY-MM-DD>.md  next to that day's CSVs (one file per date,
//     every batch of the day combined, with a Session column), and
//   - the roll-up  attendance/ATTENDANCE.md  (sessions table + per-student tally).
//
// A FLAGGED row is one whose signature does not match the secret (a hand-made or
// screenshotted-and-edited QR). The run exits nonzero if any batch has a flagged
// row, so a red run means "look at this session" - like audit-names.
//
// A row whose signature is the literal word "manual" is teacher-attested manual
// attendance (added via the console's manual-attendance intent or by hand in the
// teacher repo). It counts as present and shows as MANUAL, never FLAGGED: these
// CSVs live in the private teacher repo, so the ability to commit one IS the
// teacher's authority - the same trust the gradebook itself rests on. Students
// never hold this word as a QR; a QR carrying "manual" would only mark its
// owner present, which is what scanning any valid QR does anyway.
//
// Purely local: reads attendance/ in the teacher checkout, writes .md files. The
// workflow commits them ([skip ci]). No student repos are touched.
//
// Usage: node tools/verify-attendance.mjs
// Env: SECTION (the class), ATTENDANCE_HMAC_SECRET (same key the QRs were signed with).

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const section = process.env.SECTION || "";
const SECRET = process.env.ATTENDANCE_HMAC_SECRET || "";
if (!section) { console.error("SECTION not set"); process.exit(1); }
if (!SECRET) { console.error("ATTENDANCE_HMAC_SECRET not set - cannot verify signatures"); process.exit(1); }

const ROOT = "attendance";
const SESSIONS = join(ROOT, "sessions");
const sign = (num) =>
  createHmac("sha256", SECRET).update(`${section}:${num}`).digest("base64url").slice(0, 12);

// roster.json (number -> name) is optional; names just make the summaries nicer.
let roster = {};
try { roster = JSON.parse(readFileSync(join(ROOT, "roster.json"), "utf8")); } catch { /* no roster yet */ }
const nameOf = (num) => roster[num] || "";

// Parse a batch CSV. Tolerant of a header line and blank lines.
const parseCsv = (text) => {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [ts, num, sig] = t.split(",").map((c) => (c || "").trim());
    if (!num || num.toLowerCase() === "studentnumber") continue; // header / junk
    out.push({ ts, num, sig });
  }
  return out;
};

// ---- walk attendance/sessions/<date>/*.csv -------------------------------
const batches = []; // { date, file, label, rows:[{num,name,ts,ok}], flagged }
if (existsSync(SESSIONS)) {
  for (const date of readdirSync(SESSIONS).sort()) {
    const dir = join(SESSIONS, date);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".csv")) continue;
      const csvPath = join(dir, f);
      const rows = parseCsv(readFileSync(csvPath, "utf8")).map((r) => ({
        ...r, name: nameOf(r.num), ok: !!r.sig && r.sig === sign(r.num),
        manual: r.sig === "manual", // teacher-attested (see header note)
      }));
      const label = basename(f, ".csv"); // e.g. "1430-on-time"
      const flagged = rows.filter((r) => !r.ok && !r.manual).length;
      batches.push({ date, dir, csvPath, label, rows, flagged });
    }
  }
}

// ---- per-date .md (one file per date; Session column) --------------------
// One summary per day, combining every batch scanned that day. The folder is
// already the date, so a single <date>.md with a Session column reads better
// than N tiny per-batch files (which this also cleans up).
const dayMdPath = (date) => join(SESSIONS, date, `${date}.md`);
const byDate = new Map();
for (const b of batches) {
  if (!byDate.has(b.date)) byDate.set(b.date, []);
  byDate.get(b.date).push(b);
}
for (const [date, dayBatches] of byDate) {
  const dir = join(SESSIONS, date);
  // Drop any stale generated .md (including the old per-batch files) so only
  // <date>.md remains; the .md are always regenerated from the CSVs below.
  for (const f of readdirSync(dir)) if (f.endsWith(".md")) rmSync(join(dir, f));
  const present = dayBatches.reduce((n, b) => n + b.rows.length, 0);
  const flagged = dayBatches.reduce((n, b) => n + b.flagged, 0);
  const head = "| # | Session | Student number | Name | Scanned | Status |\n|---|---|---|---|---|---|";
  let n = 0;
  const body = dayBatches.flatMap((b) => b.rows.map((r) =>
    `| ${++n} | ${b.label} | ${r.num} | ${r.name || "-"} | ${r.ts || "-"} | ${r.ok ? "OK" : r.manual ? "MANUAL" : "FLAGGED"} |`)).join("\n");
  const md = `# Attendance - ${date}

- Sessions: **${dayBatches.length}** (${dayBatches.map((b) => b.label).join(", ")})
- Present: **${present}**${flagged ? `  (**${flagged} flagged** - signature did not verify)` : ""}

${head}
${body || "| - | - | - | - | - | - |"}

_Generated by verify-attendance. Do not edit by hand; edit the CSV and re-run._
`;
  writeFileSync(dayMdPath(date), md);
}

// ---- roll-up attendance/ATTENDANCE.md ------------------------------------
const totals = new Map(); // num -> Set(date) of dates present with an OK or MANUAL row
for (const b of batches) for (const r of b.rows) if (r.ok || r.manual) {
  if (!totals.has(r.num)) totals.set(r.num, new Set());
  totals.get(r.num).add(b.date);
}
const sessionsTable = batches.length
  ? ["| Date | Session | Present | Flagged | File |", "|---|---|---|---|---|",
     ...batches.map((b) => `| ${b.date} | ${b.label} | ${b.rows.length} | ${b.flagged || ""} | \`${dayMdPath(b.date)}\` |`)].join("\n")
  : "_No sessions recorded yet._";
const tally = totals.size
  ? ["| Student number | Name | Days present |", "|---|---|---|",
     ...[...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))
       .map(([num, days]) => `| ${num} | ${nameOf(num) || "-"} | ${days.size} |`)].join("\n")
  : "_No verified attendance yet._";
const totalFlagged = batches.reduce((n, b) => n + b.flagged, 0);

writeFileSync(join(ROOT, "ATTENDANCE.md"), `# Attendance summary - ${section}

_Last updated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC._

${totalFlagged ? `> **${totalFlagged} flagged scan(s)** across all sessions - review the batches below.\n\n` : ""}## Sessions

${sessionsTable}

## Days present per student

${tally}

_Generated by verify-attendance from \`attendance/sessions/**/*.csv\`._
`);

// ---- machine-readable summary.json (consumed by publish-attendance) ------
// Per-student verified attendance plus the list of session dates held, so the
// delivery step never re-parses CSVs or re-implements the HMAC. Student numbers
// only - no names, no signatures - same sensitivity as ATTENDANCE.md, and stays
// in this private teacher repo. OK (verified) and MANUAL (teacher-attested)
// rows are counted; FLAGGED (forged) rows never are.
const sessionDates = [...new Set(batches.map((b) => b.date))].sort();
const students = {};
for (const [num, days] of totals) students[num] = { present: [...days].sort(), count: days.size };
writeFileSync(join(ROOT, "summary.json"), JSON.stringify({
  section,
  sessionDates,
  lastSession: sessionDates[sessionDates.length - 1] || null,
  students,
}, null, 2) + "\n");

// ---- report + exit -------------------------------------------------------
console.log(`verify-attendance: section ${section}, ${batches.length} batch(es), ${totals.size} student(s) with attendance.`);
for (const b of batches) {
  console.log(`  ${b.date}/${b.label}: ${b.rows.length} present${b.flagged ? `, ${b.flagged} FLAGGED` : ""}`);
  if (b.flagged) console.log(`::error file=${b.csvPath}::${b.flagged} attendance row(s) failed signature verification`);
}
if (totalFlagged) process.exit(1);
