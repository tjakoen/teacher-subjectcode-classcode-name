# How this works in practice in class

This is the **chronological walkthrough**: the exact order you go from an empty
GitHub org to a class that is provably running, and how you *know* at each step
that it works. [SETUP.md](SETUP.md) is the reference for the individual settings
and click paths; this doc is the story that strings them together and adds the
validation loop that gives you confidence before real grades depend on it.

> **This whole process is meant to be AI-assisted.** Every step below can be
> driven by an AI coding assistant (e.g. Claude Code) that runs `gh` and the
> repo's workflows for you. The assistant's standing instructions are in
> [CLAUDE.md](CLAUDE.md); the catalogue of jobs you can ask for in plain
> language is in [AI-GUIDE.md](AI-GUIDE.md). Read those two alongside this. In
> practice you describe the step, the assistant proposes the exact command or
> workflow, you approve it.

Naming everywhere uses **literal lowercase values, no angle brackets**:
`teacher-6xxx-0000-instructor`, `student-6xxx-0000-juandelacruz`.

---

## The shape of it

You are building, in order:

1. A **course org** locked down so students see only their own repos.
2. A **teacher control center** repo inside that org, holding the engine.
3. A **section of students** who each create one workspace repo in the org.
4. A **first content push** that proves the engine can reach every student.
5. A **first assignment** (`m1a1`, hello world) that proves the grader works.

When step 5 comes back green for a real student submission, the platform is
confirmed end to end. Everything after that (more units, quizzes, AI feedback,
Canvas sync) is the same machinery repeated.

---

## Phase 0 - platform prerequisites (once per instructor)

Before any class, get these in place:

- **A GitHub organization** for the course. One org per course keeps access,
  Teams, and repo names clean.
- **GitHub Education** on your account and the org. This is what makes student
  **Codespaces** free (each student's own 180-core-hour quota) and unlocks the
  education tooling. Apply early; verification can take a few days.
- **An AI coding assistant** installed locally that can run shell commands and
  `gh`, authenticated as an org-admin account (`gh auth login`).

> Note on GitHub Classroom: this platform deliberately does **not** depend on
> Classroom. Everything runs on plain org repos plus GitHub Actions, so it keeps
> working regardless of Classroom's status.

---

## Phase 1 - create and lock down the org

Goal: students can create *their own* repos in the org, but cannot see anyone
else's.

1. **Base permission = none.** Org - Settings - Member privileges - Base
   permissions - set to **No permission**. This is the switch that makes the org
   private-by-default: a member sees only repos they were explicitly added to.
2. **Allow members to create private repos.** Same page - Repository creation -
   enable **Private**. Students need this to create their own workspace from the
   student template into the org.
3. **Enable Codespaces with User ownership.** Org - Settings - Codespaces:
   enable for members, then set **Codespace ownership - User ownership**. This
   bills each student's personal Education quota, never the org. Leave the org's
   $0 Codespaces budget in place as a backstop. (Full detail in
   [SETUP.md](SETUP.md) 3a.)

**How you know it works:** as a test, have a throwaway (or your own second)
account join the org and confirm it sees an empty repo list, not other repos.

---

## Phase 2 - create and configure the teacher repo

Goal: the control center exists inside the org and can reach student repos.

1. **Create from the teacher template** - Use this template - Create a new
   repository. **Owner: the course org** (not your personal account), name
   `teacher-<subjectcode>-<classcode>-<name>`, visibility **Private**.
2. **Set `course.config.json`** for this class: the org(s), the `teachers`
   accounts (for the access audit), and the workspace template owner. Nothing
   class-specific is hardcoded in `tools/` - config lives here.
3. **Add the `ORG_PAT` secret** - a fine-grained PAT scoped to the org with
   **Contents + Pull requests + Issues: write**. Org-admin status alone does
   **not** give a workflow cross-repo access; this token does. (Steps in
   [SETUP.md](SETUP.md) 2.)
4. **Add the Models / Canvas secrets when you need them** - `MODELS_PAT` for AI
   feedback, `CANVAS_TOKEN` / `CANVAS_BASE_URL` for grade sync. Not needed to
   prove the core loop; add later.

**How you know it works:** the repo lives under the **org** (check the owner in
the repo header) and the Actions tab lists the workflows.

---

## Phase 3 - add students and have them create workspaces

Goal: every student has one correctly named, org-owned, private workspace repo.

1. **Invite students to the org** (Org - People - Invite member). They must
   accept before they can create a repo in the org.
2. **Make a Team per section** named after the classCode (e.g. `0000`) and add
   students as they accept. This is your grouping and access backstop; the
   classCode in each repo title is what the workflows actually filter on.
3. **Hand students the onboarding instructions** from [SETUP.md](SETUP.md) 5
   (paste them into your LMS / first lesson, with the real subjectcode and
   classcode filled in). The critical points they must get right:
   - **Owner = the course org**, not their personal account.
   - **Name exactly** `student-<subjectcode>-<classcode>-<their-github-username>`,
     all lowercase.
   - **Visibility: Private.**
   - **Fill in every field of `student.json`.** This is what links their repo to
     the class roster (by student number, then email, then handle).

> **Tell them student.json is a per-repo, every-time habit.** Every repo they
> create from a template - the workspace now, and each activity submission repo
> later (`m1a1-...`, etc.) - starts with a blank `student.json`. They fill it in
> each time. A blank one means their work will not match to them on the roster.

**How you know it works:** run the repo-name audit (**Actions - Audit repo
names**, or ask the assistant for `audit-names.yml`). It flags wrong
sections, typo'd codes, and blank `student.json` files across the section. Fix
those with the students before you rely on anything. A clean audit means the
section is correctly wired.

---

## Phase 4 - first content push (the first real proof)

Goal: prove the engine can write into every student repo in the section.

1. Put a small unit under `content/<unit>/` on `main` (even a one-file
   `content/m0-welcome/README.md` is enough for the test).
2. **Actions - Publish material - Run workflow**, enter the unit folder name.
   It opens an auto-merged PR adding `content/<unit>/` into every `student-`
   repo in the section. Your teacher repo is never a target (it matches the
   `student-` prefix only).

**How you know it works:** the workflow run summary lists each student repo it
pushed to. Then **confirm with the students** that the folder appeared in their
workspace. If a student is missing, it is almost always a naming or ownership
mistake from Phase 3 (repo under their personal account, or wrong classCode) -
the audit from Phase 3 catches these.

---

## Phase 5 - first assignment and the grader (the end-to-end proof)

Goal: a real student submission flows through the grader and lands in the
gradebook.

1. **Have students do `m1a1`** - the hello-world activity. They create the
   submission repo from its activity template (owner = org, private, named
   `m1a1-<classcode>-<handle>`), fill `student.json`, and do the work.
2. **Run the grade sweep** - **Actions - Grade sweep** (or ask the assistant for
   `grade.yml`). It clones each `m1a1-` submission at its snapshot commit, grades
   it against the canonical tests in `grader/m1a1/`, and writes the gradebook
   (`gradebook/grades.csv`, `GRADEBOOK.md`). **This is teacher-side only - it
   never writes to student repos.**

**How you know it works:** open `GRADEBOOK.md` on the teacher repo. A graded row
for a real `m1a1` submission, with the score the tests produced, means the full
loop works: org - student repo - clone - canonical tests - gradebook.

At this point the platform is **confirmed**. Delivering those grades back to
students is a separate, deliberate step (**Publish**, dry-run by default, and
only for activities flagged `"publish": true`) - see [AI-GUIDE.md](AI-GUIDE.md).

---

## The confirmation checklist

You have proven the platform works in class when all of these are true:

- [ ] A test account in the org sees only its own repos (base permission locked).
- [ ] The teacher repo is owned by the **org** and its workflows are listed.
- [ ] `ORG_PAT` is set; a content push reaches other repos.
- [ ] Every student's workspace is org-owned, private, correctly named, with a
      filled `student.json` (repo-name audit is clean).
- [ ] A content push shows up in students' repos and they confirm receipt.
- [ ] An `m1a1` submission produces a real graded row in `GRADEBOOK.md`.

Everything the platform does afterwards - more units, quizzes, AI feedback,
Canvas sync, provisioning, pruning - is the same verified machinery. When in
doubt about any of it, ask the assistant for a **dry run first** and read the
plan before approving a write.
