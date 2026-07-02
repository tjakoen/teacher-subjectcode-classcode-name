# Quizzes

One **branch per quiz**, named after the quiz (e.g. `q1`). Each quiz folder is
split so the key never reaches students:

```
quizzes/q1/
├── published/              ← released into each student repo's quizzes/q1/
│   ├── README.md           (the questions)
│   ├── answers.json        (blank slots the student fills in)
│   └── student.json        (identity stub; classCode is graded)
└── key/                    ← STAYS here, never published
    ├── answer-key.json
    └── variant-seed.json   (optional, per-student variants)
```

Publishing copies only `published/` into each student's **existing** course repo
(no separate repo per quiz). Grading reads the student's `answers.json` and
scores it against `key/` here, in the teacher repo. Quizzes are **one
submission**: the grader scores the first pre-deadline push and ignores later
ones. (Wired up in build step 3.)
