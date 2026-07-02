# Setup - teacher repo (runbook)

Everything you do once per course, in order. Student repos need nothing but a
filled-in `student.json` (covered in §5 and in the student repo's README).

Naming everywhere uses **literal lowercase values, no angle brackets**:
`teacher-6xxx-0000-instructor`, `student-6xxx-0000-juandelacruz`.

---

## 1. Create this teacher repo in the course org

1. On the **teacher template** repo, click **Use this template → Create a new
   repository**.
2. **Owner:** the **course org**, **NOT your personal account** - required, or
   the workflows can't reach the student repos and nothing works.
3. **Name:** `teacher-<subjectcode>-<classcode>-<name>` with real values, e.g.
   `teacher-6xxx-0000-instructor`.
4. **Visibility:** **Private**.

The org is now the `repository_owner` the workflows act on automatically.

---

## 2. Add the cross-repo token (`ORG_PAT`)

Workflows act on *other* repos, so the built-in `GITHUB_TOKEN` (this repo only)
is not enough. Org-admin status does **not** give a workflow cross-repo access -
this token does.

1. **github.com → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.**
2. **Resource owner:** the **course org**.
3. **Repository access:** All repositories (or all `student-*` repos).
4. **Permissions →** Repository permissions:
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - **Issues: Read and write**
5. Generate, copy the token.
6. In **this repo → Settings → Secrets and variables → Actions → New repository
   secret**, name it **`ORG_PAT`**, paste the token.

---

## 3. Let students create their own repos

**Org → Settings → Member privileges → Repository creation →** enable
**Private**. This lets each student create their workspace from the student
template into the org. (Without it, they can only create in their personal
account.)

---

## 3a. Enable Codespaces for the class (free via Education)

So students get a zero-setup dev environment without the org being billed:

1. **Org → Settings → Codespaces → enable for members** (all members, or the
   section Teams).
2. **Org → Settings → Codespaces → Codespace ownership → User ownership → Save.**
   This bills Codespaces to each student's *personal* account, where their
   GitHub Education 180-core-hour quota applies. The org is never charged.
3. **Leave the org's $0 Codespaces budget in place** as a backstop - with User
   ownership it will not block anyone.

Every activity repo and the student workspace already include a `.devcontainer/`,
so "Create codespace on main" just works. Each activity README tells students how
to set a 10-minute idle timeout, stop, and delete Codespaces to conserve hours.


## 4. Create a Team per section and add students

1. **Org → Teams → New team.** Name it after the section, e.g. `0000`
   (matching the classCode in repo titles).
2. As students accept their org invite, add them: **Team → Add a member.**
3. Keep one Team per section. This is your access-control + grouping; the
   classCode in repo titles is what the workflows filter on, and the Team is the
   backstop.

> Tip: invite students to the **org** first (Org → People → Invite member). They
> must accept before they can create a repo in the org.

---

## 5. Onboard students - hand them this

> ⚠️ **Before you paste:** replace `<course org>`, `<subjectcode>`, and
> `<classcode>` below with **your class's real values**, and update the example
> name to match. If you leave the placeholders - or paste another class's
> example like `6xxx` - students copy the wrong subjectcode and their repos
> end up misnamed (e.g. `student-6xxx-0000-…` in a `6zzz` class). The
> repo-name audit (**Actions → Audit repo names**) catches this after the fact,
> but filling in real values here prevents it.

Give students these exact instructions (paste into your LMS / first lesson):

> **Set up your course workspace**
> 1. Accept the email invite to the **<course org>** organization.
> 2. Go to the **student template** repo → **Use this template → Create a new
>    repository**.
> 3. **Owner:** select **<course org>** - **NOT your personal account.** If it's
>    under your personal account, the class can't reach it and nothing will work.
>    (Accept your org invite first so the org appears in the Owner list.)
> 4. **Name it EXACTLY** - copy the prefix verbatim, then add only your username:
>    >    `student-<subjectcode>-<classcode>-<your-github-username>`
>    - The prefix **`student-<subjectcode>-<classcode>-`** is fixed for your
>      class. Do **not** change the subjectcode or classcode, and do not copy an
>      example from another class. Replace **only** `<your-github-username>`.
>    - all lowercase, no spaces, no `< >`.
> 5. **Visibility:** **Private**.
> 6. Open **`student.json`** and fill in **every** field. Your **classCode** is
>    the number in your repo name (e.g. `0000`). Use your real student number
>    and school email - that's how your work is matched to the class roster.
> 7. Edit files in the browser (press `.` in the repo to open the web editor) or
>    `git clone` your repo to work locally.

Why naming matters: the classCode in the title is how the class picks up your
repo, and `student.json` is what links it to you on the roster.

---

## 6. Publish course material

1. Put a unit's Markdown (+ images / PDFs) under `content/<unit>/` on the
   default branch (`main`). Write drafts on their own branches off `main` if you
   like; publishing reads the folder from whichever branch you run it on
   (normally `main`).
2. **Actions tab → Publish material → Run workflow.** Enter:
   - **unit** - the folder name under `content/` (e.g. `m1-intro`)
3. It opens an auto-merged PR adding `content/<unit>/` into every `student-` repo
   in that section. Re-running with the same unit just updates the folder.

Your own teacher repo is never a target (publishing matches the `student-`
prefix only).

---

## Later (when you have real students)

- **Canvas roster:** export the section's gradebook CSV from Canvas, drop it in
  as `roster/<classCode>.csv` - used to map students and produce the import CSV.
  *Skip for now; test it against a real roster.*
- **Quizzes & grading:** wired up in later build steps.
