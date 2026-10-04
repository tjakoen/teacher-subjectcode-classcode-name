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

## Publishing repositories with underscores

The publisher normalizes underscores to hyphens when checking the section in a submission repository name, as grading already does. It keeps the real repository name in the gradebook and receipt. This prevents a graded submission from being silently skipped during delivery because of its separators; it does not resolve conflicting student identities or rename a repository. A deterministic result with no valid test denominator, such as 0/0 after a failed build or source lookup, remains held rather than being published as a zero. Previously valid receipts remain eligible.


## Private authorship estimates

Authorship estimates in instructor notes remain private. Publishing grades and
pushing Canvas feedback do not automatically turn those estimates into a
student-facing warning. Any discussion of authorship with a student must be
written and explicitly reviewed as student-facing feedback. Reviewing a score
does not itself authorize a separate authorship warning.

## Submission source ownership

The optional `sourceOwner` gradebook column records the verified GitHub account that owns a submission repository. A blank value preserves the existing course-org default. Repository ownership must be corroborated with the submitted source and student identity before this metadata is entered; a matching repository name alone is insufficient.

The grading sweep reads both the preceding CSV format and the extended format and preserves ownership on regrading. Reviewed scores and existing fields remain unchanged by the schema migration. INTROWEB retains a saved preview link when no regenerated link is available. Publishing includes source ownership in receipts and builds commit references from the recorded owner. Canvas comments use the same provenance. Cleanup checks owner and repository pairs; an inaccessible personal source remains uncertain and is not automatically pruned.

Source ownership does not approve an AI proposal, resolve a group exception or authorize a score change. Use the normal instructor-review and full-table delivery checks. Console support must be deployed separately before the hosted review interface can use this metadata.

## Duplicate publication sources

Publishing emits one grade-table row and one receipt per activity. Equivalent displayed marks use the latest graded source. Different marks, or different sources tied at the latest grading timestamp, stop the batch before any student write. Resolve the source evidence and instructor decision first; do not delete a conflicting row merely to make publication succeed. This selection does not authorize a change to a locked or previously delivered mark. Compare the complete proposed table with the existing workspace and Canvas before executing publication.

## Delivery evidence and complete tables

A real workspace publish must include the complete section. Activity and repository filters are available only for dry runs; combining either with execute stops before any student write. Conflicting duplicate marks also stop the batch. A genuine no-change workspace is reported separately from a failed commit or push.

Canvas delivery requires readable existing submissions for locked activities and comment deduplication. A failed read stops planning. Blank, invalid, negative or over-rubric reviewed scores remain held, and existing half-point rounding is preserved. Repository-derived grouping includes the effective source owner; explicit student identities can still join related sources. If different owners share a legacy feedback path, Canvas delivery holds that feedback until its source is resolved. Private authorship estimates never generate automatic student warnings.

### Source identity during grading and cleanup

A grade row can declare sourceOwner when its repository belongs to a different GitHub account. Blank legacy owners resolve to the configured course owner. Sweep caches, prior reviews and identity updates use the effective owner, repository and activity together. Newly graded rows record the owner actually cloned. A personal-source review never transfers to a same-named course repository. Sibling identity fallback uses only consistent course-owned evidence, and competing source owners keep legacy feedback paths held. Cleanup validates repository names and preserves personal sources when access cannot be confirmed.

### Feedback privacy validation

Delivery rejects nonempty draft notes without a standalone `---` boundary between student prose and the instructor section. It also rejects private score or authorship metadata in student prose. Canvas comments use the separated student section and explicit criterion point allocations; free-form instructor bullets remain private. Workspace feedback uses the reviewed student prose in the gradebook. Repair and individually review malformed feedback before retrying delivery; a reviewed score does not waive this privacy check.
