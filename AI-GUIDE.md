# Running this course with an AI assistant

This teacher repo is built to be driven by an AI coding assistant (e.g. Claude
Code in your terminal or IDE). You describe what you want in plain language; the
assistant runs the repo's tools and GitHub Actions for you. This guide shows the
common jobs and - just as important - the guardrails that keep grades safe.

## One-time setup

1. Install an AI coding assistant that can run shell commands and `gh`.
2. `gh auth login` as an account with access to the course org.
3. Set the Canvas secrets on this repo (Settings > Secrets and variables >
   Actions): `CANVAS_TOKEN` (a Canvas access token with grade-write rights) and
   `CANVAS_BASE_URL`. The course id is already baked into the push workflow.

## The mental model

- **`grades.csv` is the source of truth.** The grade sweep computes it from
  student submissions; everything else (Canvas, receipts) is downstream.
- **The assistant proposes, then acts.** Ask for a dry run first; read it; then
  approve the real run. Every grade-affecting tool defaults to safe.
- **Nothing is deleted for you.** The assistant can rename and edit, but
  deleting student repos is left to you (it's irreversible).
- **The org owns every repo; the student is admin of their own.** The org must
  own each repo so the engine can grade it and deliver results; within that,
  each student is the legitimate admin of *their* repos. Only teachers should be
  org owners or hold admin on the infrastructure repos (this control center,
  solutions, templates), and no student should be able to reach another
  student's repo. The audit checks all of this (see below).

## Common jobs (just ask for these in your own words)

| You want to... | What the assistant runs | Notes |
| --- | --- | --- |
| Grade the latest submissions | `grade.yml` (dry run, then real) | Teacher-side only; writes the gradebook + AI notes. Never touches student repos |
| Deliver grades/feedback to students | `publish.yml` (dry run, then publish) | Pushes GRADES.md + FEEDBACK.md to student repos, only for activities with `"publish": true` |
| Preview Canvas grades | `canvas-push.yml` mode `dry-run` | Writes nothing; shows the plan |
| Reconcile roster vs `student.json` | `canvas-push.yml` mode `check` | Read-only; lists who won't match |
| Push grades to Canvas | `canvas-push.yml` mode `execute` | Idempotent; overwrites unlocked grades |
| Post feedback comments | push with `comment=true` | De-duplicated; safe to re-run |
| Audit repo hygiene and access | `tools/org-audit.mjs` | Read-only; junk/dup/misnamed repos plus an access pass (who can reach what) |
| Sync activity points from Canvas | `tools/canvas-pull-points.mjs` | Read-only; writes `totalPoints` only with `--execute` |
| Make grades back into a CSV | `tools/canvas-export.mjs` | Offline alternative to the API push |
| Publish course material to students | `publish-material.yml` | Copies a unit's `content/` into every workspace; instructor zone only, never the student zone |
| Check repo names for typos / wrong section | `audit-names.yml` | Read-only; flags misnamed repos and blank `student.json` |
| Provision missing workspaces / backfill `student.json` | `provision-workspaces.yml` (dry run, then `execute`) | Creates a workspace for any student who has activities but none; fills a blank `student.json` from their own submissions; never deletes or renames |
| Clean stale gradebook rows | `prune-gradebook.yml` (dry run, then `execute`) | Drops rows whose submission repo was deleted/renamed (404); commits `grades.csv` + `GRADEBOOK.md` |

## Housekeeping & content (ask in plain language)

Not everything is a single workflow. These are the "help me keep this tidy and
correct" jobs the assistant is good at - ask for a **read-only check first**,
then approve any changes:

- **"Audit my whole org for hygiene"** - malformed names, duplicate submissions,
  studentNumber collisions, junk/sample repos, blank `student.json`. Start with
  `tools/org-audit.mjs` (read-only) before fixing anything.
- **"Audit who can access what"** - the same `tools/org-audit.mjs` ends with an
  **access pass**: rogue org owners (anyone but a teacher), non-teacher access on
  infrastructure repos (this control center, solutions, templates, demos), a
  student repo shared with a second non-teacher account (a peer may be able to
  see it), a workspace with **no** student collaborator (delivered grades would
  be invisible to the student), and a permissive org base permission (members
  seeing repos they were never added to). Set `teachers` in `course.config.json`
  so your own accounts are recognized. **Fixes stay manual:** demoting an org
  owner needs the `admin:org` scope (`gh auth refresh -h github.com -s
  admin:org`) and a human; adding a student back to their own workspace is a
  `gh api` collaborator call you approve.
- **"Reorganize / rename these repos"** - the assistant proposes the renames;
  you approve. Renames are fine; **deletes stay manual** (see the guardrails).
- **"Check my content for a unit"** - read `content/<unit>/` for gaps, broken
  links, inconsistent naming, or an activity stub that accidentally gives away
  the answer. Ask it to report, not rewrite, unless you say so.
- **"Review this `RUBRIC.md` / `class-prompt.md`"** - sanity-check weights,
  clarity, and that the AI-feedback prompt matches the class level, before a
  grade run uses it.
- **"Add a new AI-graded activity"** - set the flags in
  `grader/assignments.json`, add `grader/<id>/RUBRIC.md`, and distribute that
  rubric to the activity template + existing submission repos.
- **"Confirm my engine is consistent"** - verify the shared `tools/*.mjs` are
  byte-identical across your teacher repos (nothing class-specific hardcoded;
  config lives in `course.config.json`).

## Guardrails worth knowing

- **Idempotency:** re-pushing writes the same grade for an unchanged gradebook;
  comments are de-duplicated so re-runs don't stack. So a repeated push is safe.
- **`grader/assignments.json` flags** control the push per activity:
  - `"locked": true` - a grade Canvas already has is never overwritten.
  - `"manual": true` - never auto-pushed (you grade/enter it by hand). AI-graded
    rubric projects use this: you review the AI's proposed total grade, then
    publish it yourself ("review then publish").
  - `"totalPoints": <n>` - what the activity is worth in Canvas. Stored only to
    be **reconciled** against Canvas's live Points Possible; on a mismatch the
    push writes `gradebook/points-mismatch.md` for you to fix. How those points
    split (objective vs design) lives in `RUBRIC.md`, not here.
  - `"ai-grading": true` - turn on AI feedback for this activity (see below).
  - `"feedback": "project"` - treat it as a **design** project (always gets
    feedback + a proposed grade; the rubric's subjective half is visual design,
    judged from screenshots). Use for frontend/UI work.
  - `"feedback": "code"` - treat it as a **code-quality** project (same proposed
    grade, but the subjective rubric half is code quality - structure, naming,
    error handling, OOP/abstractions, organization, edge cases - judged from the
    code, no screenshots). Use for back-end / non-frontend work (e.g. Dart).
  - omit `feedback` for a plain activity (feedback only when it did not score
    perfectly).
  - `"publish": true` - deliver this activity's grades + feedback to students on
    the next `publish.yml` run. **Default false**: grading never reaches students
    until you flip this. Covers all activities, not just AI ones.
  - `"previews": "branch"` - pull the activity's published Playwright
    screenshots (from each project repo's `previews` branch) so the AI can see
    the rendered app. Omit when the sweep itself renders previews.
  - `"autoPoints": <n>` - legacy split (push only the objective `n`, rest a
    manual top-up); superseded by `totalPoints` + `manual` for AI activities,
    still honoured if a class sets it.

## AI feedback in grading

For activities with `"ai-grading": true`, the grade sweep drafts formative
feedback **after** grading, using GitHub Models (`gpt-4o-mini`, free via the
workflow's built-in token - no secret to manage). It runs only on submissions
actually (re)graded that run, so re-runs do not re-bill unchanged work; with no
token the feature simply no-ops and grading is unaffected.

What it reads: the student's source, the failing automated checks, the
activity's `RUBRIC.md`, this class's `grader/class-prompt.md`, and - for web
projects - the rendered screenshots. It never receives `student.json` (no PII
leaves the repo) and is told never to hand over the fix, only to name the
concept or ask a guiding question.

Where it goes:

- **You:** `gradebook/notes/<activity>/<repo>.md` plus a **Feedback** column in
  `GRADEBOOK.md` showing the AI's **proposed total grade** (e.g. `88/100`)
  linked to the full note. The note breaks the total into the automated half
  (translated from the checks per the rubric's weights, not the raw test count)
  and the design half, and carries an instructor-only **AI-authored likelihood**
  (low / medium / high) - a soft signal for whether the work looks AI-generated
  rather than written at the class's level, for your judgement. This is all a
  *draft for you to review*, not a grade, and none of it is shown to the student.
- **Student:** a `FEEDBACK.md` at their workspace repo root, linked from their
  `GRADES.md`, presented as your own notes - no scores, no mention that a tool
  wrote it. **It only reaches the student when you publish** (see below).

**Grading never reaches students by itself.** The grade sweep is teacher-side
only - it writes the gradebook + AI notes and stops. Feedback and grades go to a
student's repo **only** through the separate **`publish.yml`** workflow, and
**only** for activities you've marked `"publish": true`. So the flow is: grade
freely → read the AI drafts in `gradebook/notes/` → flip `"publish": true` on the
ready activities → run `publish.yml` (dry run, then `publish=true`). The proposed
grade also still goes to Canvas only when you enter it yourself.

**Styling guard:** if a web preview rendered as unstyled default-browser HTML
(usually a student's CSS not wired up), the AI gives code-only feedback and the
**teacher note carries a flag** - it never invents design praise from a blank
page, and the student copy stays silent about it.

**Token use is bounded and idempotent.** Feedback is generated only for
submissions actually (re)graded that run - the same commit hash is never sent
twice, so re-running the sweep re-bills nothing for unchanged work (notes persist
in the gradebook). It is also skipped for **locked** activities, **perfectly
scored** plain activities, and **unbuildable** submissions (no tests ran). Each
call sends trimmed, code-first source (capped, `node_modules`/tests/config and
`student.json` excluded) and at most two screenshots (mobile + desktop). To
refresh notes after editing a `RUBRIC.md` or `class-prompt.md`, re-run with
`force` (otherwise unchanged submissions keep their existing notes). On the
free/personal Models tier the sweep throttles calls and backs off on rate
limits; any submission still missing a note is picked up automatically on the
next sweep, without re-billing ones that already have a note. Concurrency is
tunable via the `FEEDBACK_CONCURRENCY` env var (default 2).
- **Matching:** students are joined to Canvas by student number, then email,
  then their repo's GitHub handle. The pushes/audits report anyone unmatched -
  the fix is almost always their `student.json`.
- **Flag, don't guess.** When the data is ambiguous (e.g. two repos with the
  same student number), the assistant records it in `gradebook/FLAGS.md` for you
  to resolve with the student rather than guessing - a wrong guess misattributes
  a grade.

## Tips for asking

- Be specific about scope ("section 0000", "only m2a1") and safety ("dry run
  first", "don't push yet").
- Ask it to **explain the plan** before a write to a live gradebook.
- It costs Actions minutes: prefer one `dry-run` (which already includes the
  roster check) over running `check` and `dry-run` separately, and reserve
  `execute` for grading milestones.
- If something looks off, ask for the run's **report artifact** - every push and
  sweep writes a human-readable report.
