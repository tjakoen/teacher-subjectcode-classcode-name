# Gradebook - source of truth

The grade sweep writes the authoritative record here:

- `GRADEBOOK.md` - human-readable table you read right in the repo.
- `grades.csv` - machine record; the export workflow turns it into the
  Canvas-import CSV.

Nothing official is ever read back from a student repo. The receipts pushed into
student repos are display-only copies. (Wired up in build step 2.)

## Exporting grades back to Canvas

`tools/canvas-export.mjs` pivots `grades.csv` (one row per repo+assignment) into
the wide CSV Canvas imports (one row per student, one column per assignment).

Run the **Canvas grade export** workflow and paste this section's Canvas
gradebook export (Canvas gradebook > Export) into the box, or run it locally:

```
node tools/canvas-export.mjs --canvas=<canvas-export.csv>
```

It writes `canvas-import.csv` (upload this in Canvas: gradebook > Import) and
`canvas-import-report.md`. Read the report first - it lists every student it
could not match to Canvas (fix their `student.json`), any graded activity with
no Canvas column, and any subjective activity that needs a manual top-up.

How it behaves:

- **Matching students:** by normalized student number (`SIS User ID`), then
  email (`SIS Login ID`); blank/typo'd rows (e.g. quiz rows from a blank
  `student.json`) are rescued via their repo's github handle.
- **Idempotent:** every emitted column keeps Canvas's `(id)`, so re-importing
  **updates** those assignments - it never duplicates them, and any assignment
  or student not in the file is left untouched.
- **Scoring:** `passed/total` scaled to each assignment's Points Possible.
- **Subjective / AI-graded activities:** mark them in `grader/assignments.json`:
  - `"manual": true` - never exported/pushed (you enter it by hand).
  - AI-graded rubric projects are **not** `manual`: they are held out of the push
    until you review them, then pushed automatically once you flip
    `"publish": true` (their reviewed final score is the grade). "Review then
    publish." See the AI feedback flags below and the Canvas push section.
  - `"totalPoints": <n>` - what the activity is worth in Canvas. Used only to be
    reconciled against Canvas's live Points Possible; a mismatch is written to
    `gradebook/points-mismatch.md`. The objective/design split lives in
    `RUBRIC.md`, not here.
  - `"autoPoints": <n>` - legacy split (export only the objective `n`, rest a
    manual top-up); superseded by `totalPoints` + `manual`, still honoured.

### AI feedback flags

These turn on AI-drafted feedback (and a proposed total grade) for an activity;
see `docs/grading-and-feedback.md` in the platform docs for the full behaviour.
They do not change what is exported to Canvas - the proposed score stays a draft
for you to review.

- `"publish": true` - deliver this activity's grades + feedback to student repos
  on the next `publish.yml` run (default false). Grading is teacher-side only;
  nothing reaches a student until this is set. Applies to all activities. For an
  **AI-graded** activity it also unblocks the Canvas push: the reviewed final
  score (the `aiScore` column) is sent with a rubric-breakdown comment (see the
  Canvas push section). Only flip it once the activity is fully reviewed.
- `"ai-grading": true` - opt this activity in (off by default).
- `"feedback": "project"` - design project: subjective rubric half is visual
  design (frontend, screenshot-led). `"feedback": "code"` - code-quality
  project: subjective half is code quality (structure, naming, error handling,
  OOP, edge cases), judged from code, no screenshots. Both propose a total grade
  at any score. Omit for a plain activity (feedback only when not perfect).
- `"previews": "branch"` - reuse the Playwright screenshots the project repo's
  CI publishes to its `previews` branch, so the AI sees the rendered app.
- Each AI-graded activity ships a **`RUBRIC.md`** (canonical copy in
  `grader/<id>/RUBRIC.md`, also placed in the activity repo for students; shape
  from `grader/RUBRIC-TEMPLATE.md`); the AI grounds its feedback and score in
  it. Plain activities have no rubric - tests alone judge them. Per-class
  tone/level lives in `grader/class-prompt.md`.

## Pushing grades straight to Canvas (API)

`tools/canvas-push.mjs` skips the file round-trip: it pulls the roster +
assignments from the Canvas API, maps our grades on, and writes them. The
matching logic is shared with the CSV export (`tools/lib/gradebook.mjs`), so it
behaves identically; only the source of the roster and the delivery differ.

Run the **Canvas grade push (API)** workflow (or locally with the env vars set):

```
CANVAS_BASE_URL=https://<your-canvas> CANVAS_TOKEN=<token> \
  node tools/canvas-push.mjs --course=<courseId> [--check] [--execute] [--comment]
```

It is **safe by default**:

- `--check` - reconcile the roster against `student.json` only; writes nothing.
- (default) **dry run** - print the exact grade plan; writes nothing.
- `--execute` - actually write the grades (bulk per assignment).
- `--comment` - also post the autograder result + commit as a submission comment.
  Comments are de-duplicated: an identical comment already on the submission is
  not posted again, so re-running never stacks duplicates (a re-graded
  submission with a new score/date does get a fresh comment).

`manual` activities are never pushed and `autoPoints` activities push only the
objective part - same rules as the export. `locked` is not consulted: a frozen
score is a real score and is sent. Re-running is idempotent (Canvas updates the
existing submission), so this is safe to run automatically after each grade sweep
once you've trusted a dry run.

**AI-graded activities** are held out of the push until you review them and set
`"publish": true`. Once published, the reviewed final score (the `aiScore`
column in `grades.csv`, filled when you approve the grade) is what is sent -
always with a submission comment carrying the rubric breakdown plus the
student-facing feedback prose. That comment deliberately excludes the
instructor-only header, the proposed-total restatement, and the AI-authored
likelihood line, and never mentions AI - the same wall the published
`FEEDBACK.md` keeps. A published AI activity whose `aiScore` is still blank
(unreviewed or flagged) is skipped, so nothing ungraded leaks out.

Needs two secrets: `CANVAS_BASE_URL` and a `CANVAS_TOKEN` with grade-write
rights. Reading `SIS User ID` needs the token's SIS-data permission; without it
the push falls back to matching on email.
