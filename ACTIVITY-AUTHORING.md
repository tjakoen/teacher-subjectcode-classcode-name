# Authoring activities

This guide has moved. The **single source of truth** for platform documentation is
the `docs/` set in the platform repo:

- **Authoring activities** (this guide): `docs/authoring-activities.md`
- **Documentation index:** `docs/README.md`

See <https://github.com/tjakoen/github-native-course-platform/tree/main/docs>.

This file is kept as a short pointer so existing links still resolve. The
per-activity data still lives in this repo (`grader/assignments.json`,
`grader/<id>/`, `grader/class-prompt.md`, `grader/RUBRIC-TEMPLATE.md`); only the
how-to prose moved to the docs. This stub is byte-identical across all teacher
repos.

## Activity badges and the private roster

Badges use explicit activity mappings in `grader/badges.json`, reviewed scores and an approved award manifest. They are not inferred from participation or module ranges. `tools/sync-student-roster.mjs` aggregates distinct student JSON values into the private `roster/students.json`; conflicting identity or ownership holds an award. The private operations workflow records certificate links, verifies publication, and tracks workspace receipts and individual email deliveries. Planning never changes grades or contacts students. Finals badge activities use `linkScope: "repo"` so the deadline snapshot includes the declared deliverable, README and project context.

The confirmed badge threshold is 75 percent on each designated activity. A combined award requires every named activity to meet that threshold independently. Approved manifests carry generic activity titles and descriptions for the certificate and class page; individual scores and private course evidence remain private.

For identity reconciliation, `--reconcile` uses direct collaborator ownership, a current Canvas roster and current individual Canvas submission bindings. Canonical identity and delivery contacts are separate from `observedFields`, which preserves the original arrays. Unknown ownership and contradictory identities remain quarantined. Superseded records and historical badge delivery state are retained. See the deployment’s private runbook for the binding cache and reconciliation command.
