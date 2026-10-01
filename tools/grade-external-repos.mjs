#!/usr/bin/env node
// grade-external-repos.mjs - AI-feedback pass for finals activities whose
// deliverable is the student's OWN public GitHub repo (not an org submission
// repo): the final project and the finals badge. grade-sweep.mjs discovers work
// by listing the teacher org; these repos live in the students' personal
// accounts, so they are never in that list.
//
// What is read for each student is the link they SUBMITTED IN CANVAS, as it
// stood at the deadline. When there is no usable link, the fallback is the repo
// named in their workspace `project/README.md`. Because these repos are public a
// plain `gh repo clone` needs no token. The resolution rules, the deadline
// snapshot and the report live in tools/lib/finals-source.mjs, shared with
// grade-workspace-docs.mjs.
//
// This tool does NOT run any automated tests (there is no canonical test suite
// for a free-form final project). It only writes the notes-input files that the
// Course Console feedback prompt turns into held-for-review drafts. It never
// sets a score and never touches student repos; delivery stays the separate,
// human-lane publish step.
//
// Usage:
//   node tools/grade-external-repos.mjs <section> [--only=<id>] [--force] [--dry-run] [--zone-only]
//
// Env: GRADE_OWNER (the teacher org; defaults to the gh user), WORKSPACE_PREFIX
// (the student workspace repo prefix for this section, e.g.
// "student-<subject>-<section>-"), and CANVAS_BASE_URL / CANVAS_TOKEN /
// CANVAS_COURSE_ID to read the submitted links (not needed with --zone-only,
// which reads only the project/README.md link).

import { execSync } from "node:child_process";
import { runFinalsTool } from "./lib/finals-source.mjs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Pull the student's project repo URL out of their workspace project/README.md.
// Students paste a github.com link; take the first one that is NOT in the
// teacher org (their own account) and normalize it to owner/repo.
function projectRepoFor(OWNER, workspace) {
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

await runFinalsTool({
  tool: "grade-external-repos",
  work: ".grade-work-external",
  describe: "External-repo (ai-grading, no sourceSubpath, no namePrefix)",
  // ai-grading, NO sourceSubpath, and NO namePrefix. A sourceSubpath marks a
  // workspace deliverable (report/docs/journal); a namePrefix marks an org
  // SUBMISSION repo graded by the sweep (e.g. the m4a4 / m5a5 capstones). The
  // finals project is the student's external public repo, so it has neither.
  // "externalRepo": false is the explicit opt-out, for a row that is ai-grading
  // only so it reaches the Console review lane and has no project repo behind
  // it at all (the APSI m6a0 title proposal).
  select: (a) => a["ai-grading"] && a.externalRepo !== false && !a.sourceSubpath && !a.namePrefix,
  // No usable link: the repo named in the workspace project/README.md.
  fallback: ({ ws, owner }) => {
    const proj = projectRepoFor(owner, ws);
    return proj ? { full: proj.full, path: "", label: `the repository linked in the workspace project/README.md (${proj.full})`, scoped: false } : null;
  },
});
