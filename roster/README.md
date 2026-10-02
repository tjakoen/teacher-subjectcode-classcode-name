# Roster

This is the **CSV exported from Canvas** - the authoritative roster. One per
section, named `<classCode>.csv`. It mirrors Canvas's columns:

| Column | What it is | Role here |
| --- | --- | --- |
| `Student` | full name | display / gradebook |
| `ID` | Canvas user ID | needed for the Canvas import on export |
| `SIS User ID` | student number | **join key** ↔ `student.json.studentNumber` |
| `SIS Login ID` | login / email | fallback join key ↔ `student.json.studentEmail` |
| `Section` | section | sanity check vs classCode |

## How the mapping works

Canvas has no idea about GitHub accounts and GitHub has no idea about Canvas
IDs - **`student.json` is the bridge**. The reconcile step:

1. Lists the org's `student-*` repos for the section, reads each `student.json`.
2. **Joins to this CSV on student number** (`SIS User ID`), falling back to
   email (`SIS Login ID`) → resolves `githubAccount ↔ Canvas ID`.
3. **Flags problems:**
   - a Canvas student with **no matching repo** (not provisioned / typo'd their
     number or email),
   - a **repo matching no Canvas student** (wrong section, bad data),
   - **cross-submission inconsistency** - a student's `student.json` differs
     between their own repos (e.g. classCode 0000 in one, 3360 in another),
   - **missing submissions** - who hasn't submitted a given activity/quiz yet,
   - classCode/section mismatches.

The export workflow reuses this join (gradebook keyed by student number → Canvas
`ID`) to produce the Canvas-import CSV.

## Aggregated private student records

`students.json` is a teacher-only index of the `student.json` observations in
submission and workspace repositories. Run `tools/sync-student-roster.mjs` from
the teacher repository with `GRADE_OWNER`, `SECTION`, and `WORKSPACE_PREFIX` set.
The default run reads data and prints counts. Add `--execute` to write the index.
It never edits a student repository, changes a grade, issues an award, or sends
an email. Configure the instructor accounts in `course.config.json` under
`teachers` before reading live workspace collaborators.

The index has `schemaVersion: 1`, `section`, `generatedAt`, `students`, and
`errors`. Each student has an opaque `studentKey`, a `fields` object,
`canonicalName`, `verifiedGithubAccount`, `workspaceRepos`, `sources`, `canvasIds`,
`identityStatus`, `holds`, `warnings`, and `badges`. The `fields` object retains distinct
observed values as arrays for `classCode`, `fullName`, `studentNumber`,
`studentEmail`, `personalEmail`, `githubAccount`, `pcNumber`, and `room`.
The student-owned `student.json` files can continue using scalar values.

A student number joins observations. The verified GitHub account comes from
the unique non-instructor collaborator on the student's workspace, rather than
from a repository name or a declared account. Every contributing source must
also have exactly one non-instructor direct collaborator matching that workspace
account. A submission cannot contribute an address for delivery merely by
claiming another student's number. Stale declared GitHub aliases remain
observations and produce a warning; direct collaborator ownership is the
authority. Missing identities, conflicting source ownership, shared emails or
accounts, and ambiguous Canvas matches hold the
record for review. PC and room variations remain observations. Each source
records its repository, observed fields, collaborator accounts, and whether
access was successfully read.

The tool reads `roster/<section>.csv` when present. Use `--canvas=<path>` for a
different Canvas export. Without a Canvas export, `canvasIds` stays empty and
the index does not claim a Canvas match.
Use `--canvas-json=<path>` for a cached Canvas roster containing each student's
numeric `id`, `studentNumber`, and `email` or `login`. JSON caches without Canvas
IDs are insufficient for this join. Missing CSV columns, empty exports, or JSON
records without Canvas IDs stop the run. Check the printed `canvasRecords` count
against the class enrollment: a valid export can still be incomplete or stale.
`canonicalName` uses the name on a unique matched Canvas record. When no Canvas
record matches, it uses the observed name only if all observed names agree after
case and whitespace normalization. The full observed name arrays remain intact.

Award links and delivery state belong in each student's `badges` array. A
refresh preserves existing badge objects and other additional student fields.
Records whose sources disappear remain in the index with `stale: true` and a
review hold, and the run reports their retention. Invalid source JSON is
reported rather than being treated as evidence of deletion. An invalid or
incompatible previous index stops the run before any write.

For offline checks, pass `--from-snapshot=<path>` with an array of records shaped
as `{repo, student, collaborators, workspace}`. `student` can be a parsed object
or a JSON string. An omitted `collaborators` array means access could not be
verified. Snapshot runs also default to a dry run.

The confirmed badge threshold is 75 percent on each designated activity. A combined award requires every named activity to meet that threshold independently. Approved manifests carry generic activity titles and descriptions for the certificate and class page; individual scores and private course evidence remain private.

For identity reconciliation, `--reconcile` uses direct collaborator ownership, a current Canvas roster and current individual Canvas submission bindings. Canonical identity and delivery contacts are separate from `observedFields`, which preserves the original arrays. Unknown ownership and contradictory identities remain quarantined. Superseded records and historical badge delivery state are retained. See the deployment’s private runbook for the binding cache and reconciliation command.
