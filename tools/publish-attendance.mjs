#!/usr/bin/env node
// Deliver a per-student attendance receipt into each student workspace.
//
// The ONLY thing that writes attendance back to student repos. Reads the
// teacher-side attendance/summary.json (produced by verify-attendance) and each
// workspace's student.json, then writes attendance/MY-ATTENDANCE.md into that
// workspace - showing ONLY that student's own dates and count. Never a
// classmate's data, never a signature.
//
// Idempotent: the rendered body is derived from the data (the "through <date>"
// line uses summary.lastSession, NOT wall-clock now()), so an unchanged record
// produces a byte-identical file and the PUT is skipped. Safe to run on every
// verify (the workflow auto-runs it) without churning commits.
//
// DRY RUN BY DEFAULT: prints the plan and touches nothing until --execute.
//
// Usage: node tools/publish-attendance.mjs <section> [--execute] [--only=<handle>]
//
// Env: GH_TOKEN or ORG_PAT (cross-repo contents write), GRADE_OWNER (org),
// WORKSPACE_PREFIX (e.g. student-6apsi-2240-).

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const section = process.argv[2];
const execute = process.argv.includes("--execute");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1].toLowerCase() : null;
if (!section) {
  console.error("usage: publish-attendance.mjs <section> [--execute] [--only=<handle>]");
  process.exit(1);
}

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const trySh = (cmd, opts = {}) => { try { return sh(cmd, opts); } catch { return null; } };

const OWNER = process.env.GRADE_OWNER || sh("gh api user -q .login");
const WORKSPACE_PREFIX = process.env.WORKSPACE_PREFIX || "";
if (!WORKSPACE_PREFIX) { console.error("WORKSPACE_PREFIX not set - nowhere to look for workspaces"); process.exit(1); }

// summary.json is produced by verify-attendance. No summary -> nothing recorded.
const SUMMARY = join("attendance", "summary.json");
if (!existsSync(SUMMARY)) {
  console.error(`${SUMMARY} not found - run verify-attendance first (no attendance recorded yet).`);
  process.exit(1);
}
const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
const sessionDates = Array.isArray(summary.sessionDates) ? summary.sessionDates : [];
const lastSession = summary.lastSession || sessionDates[sessionDates.length - 1] || null;

// The student's original-case handle in a workspace name
// (student-6apsi-2240-JZRain -> "JZRain").
const stemOriginal = (repo) => {
  const i = repo.toLowerCase().indexOf(`-${String(section).toLowerCase()}-`);
  return i >= 0 ? repo.slice(i + String(section).length + 2) : repo.replace(/^[^-]*-/, "");
};

// Read a repo's student.json, retrying transient API errors (a rate-limit blip
// must not look like a blank workspace). Only a definitive 404 -> null.
const readSj = (repo) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = sh(`gh api -H "Accept: application/vnd.github.raw" repos/${OWNER}/${repo}/contents/student.json`);
      try { return JSON.parse(raw); } catch { return null; }
    } catch (e) {
      const msg = String(e.stderr || e.stdout || e.message || "");
      if (/HTTP 404|Not Found|empty repository/i.test(msg)) return null;
      execSync("sleep 2");
    }
  }
  return null;
};

// Render one student's receipt. Every session date is shown (Present / dash).
// The "through" line uses lastSession (not now()) so the body is byte-stable
// when the data is unchanged - that is what makes the auto-publish idempotent.
const receipt = (name, present) => {
  const set = new Set(present);
  const presentCount = sessionDates.filter((d) => set.has(d)).length;
  const table = sessionDates.length
    ? ["| Date | Status |", "|---|---|",
       ...sessionDates.map((d) => `| ${d} | ${set.has(d) ? "Present" : "-"} |`)].join("\n")
    : "_No sessions recorded yet._";
  return `# Your attendance - ${section}

Hi${name ? ` ${name}` : ""}, this is your attendance as recorded from your QR scans${lastSession ? `, through ${lastSession}` : ""}.

**Present: ${presentCount} of ${sessionDates.length} session${sessionDates.length === 1 ? "" : "s"}.**

${table}

If a session looks wrong, contact your instructor. Attendance is recorded when
your QR is scanned at the start of class.
`;
};

// The receipt currently published in a workspace (decoded), or null. Lets us
// skip an unchanged PUT so re-runs make no commit.
const currentBody = (repo, path) => {
  const b64 = trySh(`gh api repos/${OWNER}/${repo}/contents/${path} -q .content`);
  if (!b64) return null;
  try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return null; }
};

// ---- collect workspaces + plan -------------------------------------------
const allRepos = JSON.parse(sh(`gh repo list ${OWNER} --limit 5000 --json name,isEmpty`));
const pfx = WORKSPACE_PREFIX.toLowerCase();
const workspaces = allRepos.filter((r) => r.name.toLowerCase().startsWith(pfx) && !r.isEmpty);

const RECEIPT_PATH = "attendance/MY-ATTENDANCE.md";
const plan = { write: [], unchanged: [], skip: [] };
for (const { name } of workspaces) {
  const handle = stemOriginal(name);
  if (only && handle.toLowerCase() !== only) continue;
  const sj = readSj(name);
  const num = String(sj?.studentNumber || "").trim();
  if (!num) { plan.skip.push({ repo: name, why: "no studentNumber in student.json" }); continue; }
  const rec = summary.students?.[num] || { present: [] };
  const body = receipt(String(sj?.fullName || "").trim(), Array.isArray(rec.present) ? rec.present : []);
  if (currentBody(name, RECEIPT_PATH) === body) { plan.unchanged.push({ repo: name, num }); continue; }
  plan.write.push({ repo: name, num, body });
}

// ---- report --------------------------------------------------------------
const tag = execute ? "" : "[dry-run] ";
console.log(`attendance receipts: section ${section}, owner ${OWNER}, prefix ${WORKSPACE_PREFIX}`);
console.log(`  ${workspaces.length} workspace repos, ${sessionDates.length} session date(s) recorded\n`);
if (plan.skip.length) {
  console.log(`SKIP (${plan.skip.length}) - no student number, cannot match attendance:`);
  for (const s of plan.skip) console.log(`  ${s.repo}  (${s.why})`);
  console.log("");
}
if (plan.write.length) {
  console.log(`WRITE (${plan.write.length}):`);
  for (const w of plan.write) console.log(`  ${tag}update ${w.repo}/${RECEIPT_PATH}`);
  console.log("");
}
console.log(`UNCHANGED: ${plan.unchanged.length} workspace(s) already carry the current receipt.`);

if (!execute) { console.log(`\nDRY RUN - nothing changed. Re-run with --execute to apply.`); process.exit(0); }

// ---- execute -------------------------------------------------------------
const WORK = ".attendance-work";
mkdirSync(WORK, { recursive: true });

// Create or overwrite a file via the contents API. sha is required to overwrite.
const putFile = (repo, path, body, message) => {
  const sha = trySh(`gh api repos/${OWNER}/${repo}/contents/${path} -q .sha`);
  const payload = { message, content: Buffer.from(body, "utf8").toString("base64") };
  if (sha) payload.sha = sha;
  const bodyFile = `${WORK}/body.json`;
  writeFileSync(bodyFile, JSON.stringify(payload));
  sh(`gh api -X PUT repos/${OWNER}/${repo}/contents/${path} --input ${bodyFile}`);
};

let done = 0;
for (const w of plan.write) {
  console.log(`update ${w.repo} ...`);
  putFile(w.repo, RECEIPT_PATH, w.body, ":date: Update attendance receipt [skip ci]");
  done++;
}
rmSync(WORK, { recursive: true, force: true });
console.log(`\ndone: ${done} receipt(s) written; ${plan.unchanged.length} unchanged, ${plan.skip.length} skipped.`);
