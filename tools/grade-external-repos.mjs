#!/usr/bin/env node
// grade-external-repos.mjs - AI-feedback pass for finals activities whose
// deliverable is the student's OWN public GitHub repo (not an org submission
// repo). grade-sweep.mjs discovers work by listing the teacher org; these repos
// live in the students' personal accounts, so they are never in that list. The
// URL comes instead from each student's workspace `project/README.md` (the
// org-owned file we control), and because the repo is PUBLIC a plain
// `gh repo clone` needs no token.
//
// This tool does NOT run any automated tests (there is no canonical test suite
// for a free-form final project). It only writes the notes-input files that the
// Course Console feedback prompt turns into held-for-review drafts, exactly the
// same way grade-sweep's AI pass does - so it imports runNotesPass unchanged.
// It never sets a score and never touches student repos; delivery stays the
// separate, human-lane publish step.
//
// Usage:
//   node tools/grade-external-repos.mjs <section> [--only=<id>] [--force] [--dry-run]
//
// Env: GRADE_OWNER (the teacher org; defaults to the gh user), WORKSPACE_PREFIX
// (the student workspace repo prefix for this section, e.g.
// "student-6introweb-2106-"). --only limits to one activity id; --force
// rewrites an input even if a note already exists; --dry-run resolves and clones
// nothing, only reporting what it would do.

import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { loadGradebook } from "./lib/gradebook.mjs";
import { runNotesPass } from "./lib/ai-feedback.mjs";

const section = process.argv[2];
const args = process.argv.slice(3);
const onlyId = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

if (!section) {
  console.error("usage: grade-external-repos.mjs <section> [--only=<id>] [--force] [--dry-run]");
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

const WORK = ".grade-work-external";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Which activities this tool grades: AI-graded ones flagged in assignments.json.
// A finals set marks report/docs/project as ai-grading; journal + presentation
// are graded by hand and are correctly skipped here (warrantsFeedback is false
// for a non-ai-grading row, but we also never build a row for them).
// External-repo activities: ai-grading, NO sourceSubpath, and NO namePrefix. A
// sourceSubpath marks a workspace deliverable (report/docs/journal); a
// namePrefix marks an org SUBMISSION repo graded by the sweep (e.g. the m4a4 /
// m5a5 capstones). The finals project is the student's external public repo, so
// it has neither.
// Read the RAW assignments array (not loadPolicy, which returns a normalized
// Map keyed by id and drops sourceSubpath). runNotesPass + writeNotesInput need
// the raw objects: id, feedback, totalPoints, sourceSubpath.
const assignments = JSON.parse(readFileSync("grader/assignments.json", "utf8"));
const aiActivities = assignments.filter(
  (a) => a["ai-grading"] && !a.sourceSubpath && !a.namePrefix && (!onlyId || a.id === onlyId),
);
if (!aiActivities.length) {
  console.error(onlyId ? `No external ai-grading activity ${onlyId} (ai-grading, no sourceSubpath, no namePrefix) in assignments.json.` : "No external ai-grading activities (ai-grading, no sourceSubpath, no namePrefix) in assignments.json.");
  process.exit(1);
}
console.log(`Owner ${OWNER}, section ${section}, prefix ${WORKSPACE_PREFIX}`);
console.log(`AI-graded external activities: ${aiActivities.map((a) => a.id).join(", ")}`);

// List the section's workspaces. Mirror grade-sweep's retry/refuse-empty guard:
// a transient 503 that returned no repos must never read as "nobody to grade".
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

// Pull the student's project repo URL out of their workspace project/README.md.
// Students paste a github.com link; take the first one that is NOT in the
// teacher org (their own account) and normalize it to owner/repo.
function projectRepoFor(workspace) {
  let readme = "";
  try {
    readme = Buffer.from(
      JSON.parse(sh(`gh api repos/${OWNER}/${workspace}/contents/project/README.md`)).content,
      "base64",
    ).toString("utf8");
  } catch {
    return null; // no project/README.md yet
  }
  const urls = [...readme.matchAll(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?)\s]|$)/gi)];
  for (const m of urls) {
    const owner = m[1];
    if (owner.toLowerCase() === OWNER.toLowerCase()) continue; // that is the workspace itself
    return { owner, repo: m[2], full: `${owner}/${m[2]}` };
  }
  return null;
}

const workspaces = listWorkspaces();
console.log(`Resolved ${workspaces.length} workspace(s) for ${WORKSPACE_PREFIX}.`);

// Build one row per (workspace, ai-activity), all pointing at the same clone of
// the student's project repo. row.repo is the key runNotesPass/writeNotesInput
// use to find the clone under WORK and to name the notes-input file, so it must
// match the directory we clone into. We key on the workspace name (stable,
// identifiable, org-owned) rather than the external repo name.
const existing = (() => {
  try { return loadGradebook("gradebook/grades.csv", section).rows; } catch { return []; }
})();
const hasNote = new Set(existing.filter((r) => r.notes).map((r) => `${r.repo}|${r.assignment}`));

const rows = [];
const gradedThisRun = new Set();
let cloned = 0, noProject = 0, cloneFail = 0;

for (const ws of workspaces) {
  const proj = projectRepoFor(ws);
  if (!proj) { noProject++; console.log(`  skip ${ws} - no project repo link in project/README.md`); continue; }

  const dir = `${WORK}/${ws}`;
  if (dryRun) {
    console.log(`  would clone ${proj.full} for ${ws}`);
  } else {
    try {
      quiet(`gh repo clone ${proj.full} ${dir} -- -q --depth=1`);
      cloned++;
    } catch {
      cloneFail++;
      console.log(`  skip ${ws} - clone of ${proj.full} failed (private, deleted, or transient)`);
      continue;
    }
  }

  for (const a of aiActivities) {
    const key = `${ws}|${a.id}`;
    if (hasNote.has(key) && !force) continue; // keep an existing (maybe reviewed) note
    // total:1/passed:0 so warrantsFeedback qualifies the row - these activities
    // have no automated tests (the score is the reviewed rubric total applied
    // later), but a feedback:"code"/"project" row warrants a draft regardless.
    rows.push({ repo: ws, assignment: a.id, score: 0, passed: 0, total: 1, failures: [], notes: "", aiScore: "" });
    gradedThisRun.add(key);
  }
}

console.log(`\nCloned ${cloned}, no-project ${noProject}, clone-failed ${cloneFail}. ${rows.length} notes-input file(s) to write.`);

if (dryRun) {
  console.log("Dry run - nothing cloned, no inputs written.");
  process.exit(0);
}

// Same AI pass grade-sweep uses. It reads each clone from ctx.work, writes
// gradebook/notes-input/<id>/<workspace>.md, and never sets a score - a blank
// aiScore holds the student out of delivery until the reviewed draft is applied.
await runNotesPass(rows, assignments, gradedThisRun, { work: WORK });

console.log("\nDone. Generate drafts with the Course Console feedback prompt, review, then apply. Delivery is the separate human-lane publish step.");
