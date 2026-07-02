# Grading flags - resolve before final grades

Anomalies the automated pipeline can't safely resolve on its own. Each row is
something a human must check (usually with the student). The grade push is held
or excluded for these until cleared.

| Date | Section | What | Detail | Status |
| --- | --- | --- | --- | --- |
| _example_ | 0000 | identity collision | `m1a1-0000-foo` and `m1a1-0000-bar` carry the same student number | open |

When resolved, fix the underlying `student.json` / repo, delete the row, and
re-run the grade sweep + Canvas push for that section.
