# 🎛️ Teacher repo - instructor control center

[![Made with Claude](https://img.shields.io/badge/Made_with-Claude-D97757?logo=anthropic&logoColor=white)](https://tjakoen.github.io/notes/professional-vibe-coder)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white)
![Runtime deps: 0](https://img.shields.io/badge/runtime_deps-0-2ea44f)
![Build step: none](https://img.shields.io/badge/build_step-none-2ea44f)
![LMS: Canvas](https://img.shields.io/badge/LMS-Canvas-E13223)

The control center for one course org. Everything is driven from the
**Actions tab** (workflow_dispatch forms) - there is no hosted UI. See the
full design in the [project overview and ARCHITECTURE.md](https://github.com/tjakoen/github-native-course-platform).

> This is the **template** (teacher-subjectcode-classcode-name). A live instance is named
> teacher-<subjectcode>-<classcode>-<teachername> (e.g.
> teacher-6xxx-0000-instructor) and lives inside a **course org** (one per
> course); the org is automatically the repository_owner the workflows act on.
> Student workspaces are named student-<subjectcode>-<classcode>-<studentname>.

## Layout

| Path | Purpose |
| --- | --- |
| roster/ | <section>.csv mapping githubAccount → Canvas ID + name |
| content/<unit>/ | course material for a unit (one **folder per unit**) |
| quizzes/<quiz>/ | published/ (released) + key/ (private, never released) |
| grader/ | canonical tests + grade logic (grades run here, off the student repo) |
| gradebook/ | source of truth: GRADEBOOK.md + grades.csv |
| tools/ | small scripts the workflows call |
| .github/workflows/ | the control panel |

## One-time setup

1. Create this repo **inside the course org** (e.g. from this template).
2. Add a repo **Actions secret** ORG_PAT - a fine-grained PAT scoped to the
   org with **Contents + Pull requests + Issues: write**. (Org-admin status does
   not give a workflow cross-repo access; it needs this token.)
3. Each section is identified by its **classCode in the repo title**
   (student-6xxx-0000-juandelacruz) and, optionally, a per-section org
   **Team**. Publishing targets only student- repos, so your teacher- repo
   (same classCode) is never a target.

## Publishing model

Each unit lives in its **own folder** under content/<unit>/ on the default
branch. Publish = run the workflow with just the unit (folder name); the section
is fixed to this repo's class.
Example: publish folder content/m1-intro/.

---
🤖 **Built by [tjakoen](https://github.com/tjakoen) with Claude — I don't prompt and pray, I prompt and prove.** Every commit here is co-authored with an AI, on purpose. [How I actually work with AI, receipts and all →](https://tjakoen.github.io/notes/professional-vibe-coder) · [How I use AI in teaching →](https://tjakoen.github.io/notes/how-i-use-ai-in-teaching)
