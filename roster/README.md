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
