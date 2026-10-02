# Running this course with an AI assistant

This guide has moved. The **single source of truth** for platform documentation is
the `docs/` set in the platform repo:

- **Operating with an AI assistant** (this guide): `docs/operating-with-ai.md`
- **Documentation index:** `docs/README.md`

See <https://github.com/tjakoen/github-native-course-platform/tree/main/docs>.

The assistant's standing behavioral instructions and guardrails stay in this repo's
[CLAUDE.md](CLAUDE.md), which is read in-context. This file is kept as a short
pointer so existing links still resolve. It carries no per-course content on
purpose: course-specific values live in `course.config.json` and each workflow's
env, so this stub stays byte-identical across all teacher repos.

## Activity badges and the private roster

Badges use explicit activity mappings in `grader/badges.json`, reviewed scores and an approved award manifest. They are not inferred from participation or module ranges. `tools/sync-student-roster.mjs` aggregates distinct student JSON values into the private `roster/students.json`; conflicting identity or ownership holds an award. The private operations workflow records certificate links, verifies publication, and tracks workspace receipts and individual email deliveries. Planning never changes grades or contacts students. Finals badge activities use `linkScope: "repo"` so the deadline snapshot includes the declared deliverable, README and project context.

The confirmed badge threshold is 75 percent on each designated activity. A combined award requires every named activity to meet that threshold independently. Approved manifests carry generic activity titles and descriptions for the certificate and class page; individual scores and private course evidence remain private.

For identity reconciliation, `--reconcile` uses direct collaborator ownership, a current Canvas roster and current individual Canvas submission bindings. Canonical identity and delivery contacts are separate from `observedFields`, which preserves the original arrays. Unknown ownership and contradictory identities remain quarantined. Superseded records and historical badge delivery state are retained. See the deployment’s private runbook for the binding cache and reconciliation command.
