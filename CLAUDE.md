# CLAUDE.md — operating this course with an AI assistant

This is a live teacher control center. An AI coding assistant (e.g. Claude Code)
is expected to drive it: you describe what you want in plain language, it runs
the repo's tools and GitHub Actions. This file is the assistant's standing
instructions. The human-facing walkthrough is [AI-GUIDE.md](AI-GUIDE.md); the
one-time setup is [SETUP.md](SETUP.md).

## What this repo is

The single control center for one course org: roster, course content, quizzes,
the grader, the gradebook (source of truth), and the workflows that run
everything. Student repos are separate; this repo grades them off-repo and
delivers results to them only through a deliberate publish step.

## Safety rules (do not violate)

1. **`gradebook/grades.csv` is the source of truth.** The grade sweep computes
   it; Canvas and student receipts are downstream. Never hand-edit a grade to
   "fix" something the sweep should produce.
2. **Grading never touches student repos.** `grade.yml` is teacher-side only.
   The **only** thing that writes to student repos is `publish.yml`, and only
   for activities flagged `"publish": true`.
3. **Dry run first, always.** Every repo-mutating tool defaults to safe. Show
   the dry-run plan, let the instructor read it, then run for real on approval.
4. **Never delete or rename student repos yourself.** Flag them for the
   instructor; deletion is irreversible and needs a human + `delete_repo` scope.
5. **No student PII in chat responses.** Names, numbers, and emails stay in the
   repo, not in conversation.
6. **When data is ambiguous** (e.g. two repos with the same student number),
   record it in `gradebook/FLAGS.md` for the instructor to resolve — do not
   guess, a wrong guess misattributes a grade.
7. **Access is deliberate.** The org owns every repo so the engine can grade and
   deliver; within that, each student is the admin of their own repos and no one
   else's. Only teachers are org owners or hold admin on infrastructure repos
   (this control center, solutions, templates, demos). Never add a student as a
   collaborator on another student's repo and never make a repo public.
   `tools/org-audit.mjs` audits this; changing an org owner or a collaborator is
   a human-approved action (demoting an owner needs the `admin:org` scope).

## Configuration

Class-specific values live in **`course.config.json`** (orgs, `teachers` for the
access audit, workspace template owner) and each workflow's `SECTION` /
`WORKSPACE_PREFIX` env, plus the
`CANVAS_TOKEN` / `CANVAS_BASE_URL` / `ORG_PAT` / `MODELS_PAT` secrets. Nothing
class-specific is hardcoded in `tools/` — read config, do not edit the tools to
change a value.

## Conventions

- **Gitmoji** commit subject prefixes; **no em dashes**; **no AI co-author
  trailers** in commits.
- Always `node --check` a changed `.mjs` before committing.
- Prefer one efficient sweep/push over many tiny runs (it costs Actions minutes).

See [AI-GUIDE.md](AI-GUIDE.md) for the common jobs and how to ask for them.
