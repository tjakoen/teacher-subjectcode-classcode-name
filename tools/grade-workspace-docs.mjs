#!/usr/bin/env node
// grade-workspace-docs.mjs - AI-feedback pass for finals activities whose
// deliverable is prose the student writes, not code in a submission repo: the
// increment reports, the documentation updates and the reflection journals.
// Each such activity names its usual workspace zone with a `sourceSubpath` in
// assignments.json (`project` or `journal`).
//
// What is read for each student is the link they SUBMITTED IN CANVAS (the file
// or folder it names, in their workspace or their own project repo), as it
// stood at the deadline. The workspace zone is only the fallback when there is
// no usable link. The resolution rules, the deadline snapshot and the report
// live in tools/lib/finals-source.mjs, shared with grade-external-repos.mjs.
//
// Like the sweep's AI pass it writes only notes-input files (held-for-review),
// never a score, and never touches any repo. Delivery stays human-lane.
//
// Usage:
//   node tools/grade-workspace-docs.mjs <section> [--only=<id>] [--force] [--dry-run] [--zone-only]
//
// Env: GRADE_OWNER (the teacher org; defaults to the gh user), WORKSPACE_PREFIX
// (the student workspace repo prefix for this section), and CANVAS_BASE_URL /
// CANVAS_TOKEN / CANVAS_COURSE_ID to read the submitted links (not needed with
// --zone-only).

import { runFinalsTool } from "./lib/finals-source.mjs";

await runFinalsTool({
  tool: "grade-workspace-docs",
  work: ".grade-work-workspace",
  describe: "Workspace-deliverable (ai-grading + sourceSubpath)",
  // ai-grading AND a sourceSubpath: the subpath is what separates these from
  // the external project (ai-grading, no subpath), graded by the other tool.
  select: (a) => a["ai-grading"] && a.sourceSubpath,
  // No usable link: the activity's zone in the student's workspace.
  fallback: ({ ws, a, owner }) => ({ full: `${owner}/${ws}`, path: a.sourceSubpath, label: `the workspace \`${a.sourceSubpath}/\` folder`, scoped: true }),
});
