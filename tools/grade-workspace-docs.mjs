#!/usr/bin/env node
// grade-workspace-docs.mjs - AI-feedback pass for finals activities whose
// deliverable is prose the student writes INSIDE their org-owned workspace, not
// a submission repo and not their external project repo. The finals increment
// report and documentation live in the workspace `project/` zone and the
// reflection journal in `journal/`; each activity names its zone with a
// `sourceSubpath` in assignments.json.
//
// Unlike grade-external-repos.mjs (which clones the student's PUBLIC project
// repo), this clones the WORKSPACE repo (org-owned, private, so the clone uses
// the normal gh token) and scopes the ai-feedback source collection to the one
// subfolder that is the student's submission - the rest of the workspace is
// instructor-owned content and must not be read as their work.
//
// Like the sweep's AI pass it writes only notes-input files (held-for-review),
// never a score, and never touches any repo. Delivery stays human-lane.
//
// Usage:
//   node tools/grade-workspace-docs.mjs <section> [--only=<id>] [--force] [--dry-run]
//
// Env: GRADE_OWNER (the teacher org; defaults to the gh user), WORKSPACE_PREFIX
// (the student workspace repo prefix for this section).

import { execSync } from "node:child_process";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { loadGradebook } from "./lib/gradebook.mjs";
import { runNotesPass } from "./lib/ai-feedback.mjs";

const section = process.argv[2];
const args = process.argv.slice(3);
const onlyId = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

if (!section) {
  console.error("usage: grade-workspace-docs.mjs <section> [--only=<id>] [--force] [--dry-run]");
  process.exit(1);
}

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = (cmd) => execSync(cmd, { stdio: ["ignore", "ignore", "ignore"] });

const OWNER = process.env.GRADE_OWNER || sh("gh api user -q .login");
const WORKSPACE_PREFIX = process.env.WORKSPACE_PREFIX;
if (!WORKSPACE_PREFIX) {
  console.error("WORKSPACE_PREFIX env is required (e.g. student-6introweb-2106-). It is set per section in the workflow.");
  process.exit(1);
}

const WORK = ".grade-work-workspace";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Workspace-deliverable activities: ai-grading AND a sourceSubpath. The
// sourceSubpath is what separates these from the external-repo project (a7,
// which has ai-grading but no subpath and is graded by grade-external-repos).
// Read the RAW assignments array (not loadPolicy, which returns a normalized
// Map keyed by id and drops sourceSubpath). runNotesPass + writeNotesInput need
// the raw objects: id, feedback, totalPoints, sourceSubpath.
const assignments = JSON.parse(readFileSync("grader/assignments.json", "utf8"));
const wsActivities = assignments.filter(
  (a) => a["ai-grading"] && a.sourceSubpath && (!onlyId || a.id === onlyId),
);
if (!wsActivities.length) {
  console.error(onlyId ? `No ai-grading + sourceSubpath activity ${onlyId} in assignments.json.` : "No ai-grading activities with a sourceSubpath in assignments.json.");
  process.exit(1);
}
console.log(`Owner ${OWNER}, section ${section}, prefix ${WORKSPACE_PREFIX}`);
console.log(`Workspace-deliverable activities: ${wsActivities.map((a) => `${a.id}(${a.sourceSubpath})`).join(", ")}`);

// List the section's workspaces, with grade-sweep's retry/refuse-empty guard.
function listWorkspaces() {
  let names = null;
  for (let attempt = 1; attempt <= 3 && !names; attempt++) {
    try {
      names = JSON.parse(sh(`gh repo list ${OWNER} --limit 5000 --json name -q '[.[].name]'`));
    } catch (e) {
      console.error(`attempt ${attempt}: listing ${OWNER} failed (${e.message.split("\n")[0]})`);
    }
  }
  if (!names) {
    console.error(`Listing ${OWNER} returned no repos after 3 attempts. Refusing to report a clean run that graded nobody.`);
    process.exit(1);
  }
  return names.filter((n) => n.toLowerCase().startsWith(WORKSPACE_PREFIX.toLowerCase()));
}

const workspaces = listWorkspaces();
console.log(`Resolved ${workspaces.length} workspace(s) for ${WORKSPACE_PREFIX}.`);

const existing = (() => {
  try { return loadGradebook("gradebook/grades.csv", section).rows; } catch { return []; }
})();
const hasNote = new Set(existing.filter((r) => r.notes).map((r) => `${r.repo}|${r.assignment}`));

const rows = [];
const gradedThisRun = new Set();
let cloned = 0, cloneFail = 0;

for (const ws of workspaces) {
  const dir = `${WORK}/${ws}`;
  if (dryRun) {
    console.log(`  would clone workspace ${OWNER}/${ws}`);
  } else {
    try {
      quiet(`gh repo clone ${OWNER}/${ws} ${dir} -- -q --depth=1`);
      cloned++;
    } catch {
      cloneFail++;
      console.log(`  skip ${ws} - workspace clone failed (transient or deleted)`);
      continue;
    }
  }
  for (const a of wsActivities) {
    const key = `${ws}|${a.id}`;
    if (hasNote.has(key) && !force) continue; // keep an existing (maybe reviewed) note
    // total:1/passed:0 so warrantsFeedback qualifies the row - these workspace
    // deliverables have no automated tests; a feedback:"code" row warrants a
    // draft regardless (the score is the reviewed rubric total applied later).
    rows.push({ repo: ws, assignment: a.id, score: 0, passed: 0, total: 1, failures: [], notes: "", aiScore: "" });
    gradedThisRun.add(key);
  }
}

console.log(`\nCloned ${cloned}, clone-failed ${cloneFail}. ${rows.length} notes-input file(s) to write.`);

if (dryRun) {
  console.log("Dry run - nothing cloned, no inputs written.");
  process.exit(0);
}

// The ai-feedback pass reads each clone from ctx.work and, via a.sourceSubpath,
// scopes collectSourceFiles to the student's zone. It never sets a score.
await runNotesPass(rows, assignments, gradedThisRun, { work: WORK });

console.log("\nDone. Generate drafts with the Course Console feedback prompt, review, then apply. Delivery is the separate human-lane publish step.");
