#!/usr/bin/env node
// Generate a signed Attendance QR for every student workspace that lacks one,
// and (re)build the teacher-side roster the scanner uses to show names.
//
// The QR encodes  <studentNumber>.<sig>  where
//   sig = first 12 base64url chars of HMAC-SHA256(ATTENDANCE_HMAC_SECRET,
//         "<section>:<studentNumber>").
// The student number is in the clear (so the scanner can look up a name); the
// signature is what a forger cannot mint without the secret. Verification lives
// ONLY in verify-attendance.mjs (a workflow that holds the secret), NEVER in the
// public scanner page - so putting the scanner on GitHub Pages leaks nothing.
//
// For each workspace repo (WORKSPACE_PREFIX*) with a filled student.json it:
//   - renders attendance/attendance-qr.png (skipped if present; --force to redo)
//   - writes a short attendance/README.md ("save this to your Photos")
// committed as course-bot, [skip ci]. It NEVER deletes or renames anything.
//
// It also writes attendance/roster.json into THIS teacher repo
// (studentNumber -> fullName) for the scanner. roster.json holds NO signatures:
// publishing a valid signature would hand every student a forgery for a
// classmate. The workflow commits roster.json; this tool only writes it.
//
// DRY RUN BY DEFAULT: prints the plan and touches nothing until --execute.
//
// Usage: node tools/generate-attendance-qrs.mjs <section> [--execute] [--force] [--only=<handle>]
//
// Env: GH_TOKEN or ORG_PAT (cross-repo contents write), GRADE_OWNER (org),
// WORKSPACE_PREFIX (e.g. student-6apsi-2240-), ATTENDANCE_HMAC_SECRET (signing key).

import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const section = process.argv[2];
const execute = process.argv.includes("--execute");
const force = process.argv.includes("--force");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1].toLowerCase() : null;
if (!section) {
  console.error("usage: generate-attendance-qrs.mjs <section> [--execute] [--force] [--only=<handle>]");
  process.exit(1);
}

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const trySh = (cmd, opts = {}) => { try { return sh(cmd, opts); } catch { return null; } };

const OWNER = process.env.GRADE_OWNER || sh("gh api user -q .login");
const WORKSPACE_PREFIX = process.env.WORKSPACE_PREFIX || "";
if (!WORKSPACE_PREFIX) { console.error("WORKSPACE_PREFIX not set - nowhere to look for workspaces"); process.exit(1); }
const SECRET = process.env.ATTENDANCE_HMAC_SECRET || "";
if (!SECRET) { console.error("ATTENDANCE_HMAC_SECRET not set - cannot sign QRs (add the repo secret)"); process.exit(1); }

// sig = first 12 base64url chars of HMAC-SHA256(secret, "<section>:<num>").
const sign = (num) =>
  createHmac("sha256", SECRET).update(`${section}:${num}`).digest("base64url").slice(0, 12);
const qrText = (num) => `${num}.${sign(num)}`;

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

const README = `# Your Attendance QR

\`attendance-qr.png\` is your personal attendance QR for this class. Save it to
your phone's Photos and show it at the start of each session so your attendance
is recorded. It is unique to you - do not share it.
`;

// ---- collect workspaces + identities -------------------------------------
const allRepos = JSON.parse(sh(`gh repo list ${OWNER} --limit 5000 --json name,isEmpty`));
const pfx = WORKSPACE_PREFIX.toLowerCase();
const workspaces = allRepos.filter((r) => r.name.toLowerCase().startsWith(pfx) && !r.isEmpty);

const plan = { generate: [], have: [], skip: [] };
const roster = {}; // studentNumber -> fullName (for the scanner)
for (const { name } of workspaces) {
  const handle = stemOriginal(name);
  if (only && handle.toLowerCase() !== only) continue;
  const sj = readSj(name);
  const num = String(sj?.studentNumber || "").trim();
  if (!num) { plan.skip.push({ repo: name, why: "no studentNumber in student.json" }); continue; }
  roster[num] = String(sj?.fullName || "").trim();
  const hasQr = !!trySh(`gh api repos/${OWNER}/${name}/contents/attendance/attendance-qr.png -q .sha`);
  if (hasQr && !force) { plan.have.push({ repo: name, num }); continue; }
  plan.generate.push({ repo: name, num, regen: hasQr });
}

// ---- report --------------------------------------------------------------
const tag = execute ? "" : "[dry-run] ";
console.log(`attendance QRs: section ${section}, owner ${OWNER}, prefix ${WORKSPACE_PREFIX}`);
console.log(`  ${workspaces.length} workspace repos, ${Object.keys(roster).length} with a student number\n`);
if (plan.skip.length) {
  console.log(`SKIP (${plan.skip.length}) - no student number, cannot sign:`);
  for (const s of plan.skip) console.log(`  ${s.repo}  (${s.why})`);
  console.log("");
}
if (plan.generate.length) {
  console.log(`GENERATE (${plan.generate.length}):`);
  for (const g of plan.generate) console.log(`  ${tag}${g.regen ? "regenerate" : "create"} ${g.repo}/attendance/attendance-qr.png`);
  console.log("");
}
console.log(`HAVE: ${plan.have.length} workspace(s) already carry a QR (use --force to regenerate).`);

if (!execute) { console.log(`\nDRY RUN - nothing changed. Re-run with --execute to apply.`); process.exit(0); }

// ---- execute -------------------------------------------------------------
const WORK = ".attendance-work";
mkdirSync(WORK, { recursive: true });

// Commit a file via the contents API using --input (a PNG's base64 is far too
// long to pass as a -f argument). sha is required to overwrite an existing file.
const putFile = (repo, path, base64, message) => {
  const sha = trySh(`gh api repos/${OWNER}/${repo}/contents/${path} -q .sha`);
  const body = { message, content: base64 };
  if (sha) body.sha = sha;
  const bodyFile = `${WORK}/body.json`;
  writeFileSync(bodyFile, JSON.stringify(body));
  sh(`gh api -X PUT repos/${OWNER}/${repo}/contents/${path} --input ${bodyFile}`);
};

const { default: QRCode } = await import("qrcode");
let done = 0;
for (const g of plan.generate) {
  console.log(`${g.regen ? "regenerate" : "create"} ${g.repo} ...`);
  const png = await QRCode.toBuffer(qrText(g.num), { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
  putFile(g.repo, "attendance/attendance-qr.png", png.toString("base64"),
    ":lock: Add attendance QR [skip ci]");
  // README is nice-to-have; add it only when missing so we don't churn commits.
  if (!trySh(`gh api repos/${OWNER}/${g.repo}/contents/attendance/README.md -q .sha`)) {
    putFile(g.repo, "attendance/README.md", Buffer.from(README, "utf8").toString("base64"),
      ":memo: Add attendance QR instructions [skip ci]");
  }
  done++;
}

// roster.json for the scanner (written into THIS teacher repo; the workflow
// commits it). Number -> name only; never signatures.
mkdirSync("attendance", { recursive: true });
writeFileSync("attendance/roster.json", JSON.stringify(roster, null, 2) + "\n");
rmSync(WORK, { recursive: true, force: true });
console.log(`\ndone: ${done} QR(s) written; attendance/roster.json refreshed (${Object.keys(roster).length} students).`);
