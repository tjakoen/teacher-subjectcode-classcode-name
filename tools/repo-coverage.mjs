#!/usr/bin/env node
// "No activity repo left ungraded" audit for THIS section. Lists every activity
// submission repo (m#a#/prelim/q#) on the org, checks which carry a gradebook
// row, and flags: (a) repos with NO grade, (b) activities that have repos but are
// NOT in assignments.json (the sweep ignores them). Read-only.
//
// The org repo list comes from the workflow (`gh repo list <org>` piped to a
// file); pass it with --repos=<path>. --limit on that gh call MUST exceed the
// org's repo count (see the platform 5000 rule) or repos get silently dropped.
//
// Usage:
//   node tools/repo-coverage.mjs [--section=<code>] [--org=<org>]
//                                [--repos=repos.txt] [--report=<path>]
// Output: reports/repo-coverage.md (rendered in the Course Console).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseCsv, loadPolicy } from "./lib/gradebook.mjs";

const arg = (name, def = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const section = arg("section") || process.env.SECTION || "";
const org = arg("org") || process.env.GRADE_OWNER || "";
const reposFile = arg("repos", "repos.txt");
const reportPath = arg("report", "reports/repo-coverage.md");
if (!section) { console.error("no section: set SECTION in the env or pass --section=<code>"); process.exit(1); }

const actOf = (repo, sec) => {
  const m = repo.toLowerCase().match(new RegExp(`^(?:hau-[a-z0-9]+-)?(m\\d+a\\d+|prelim|q\\d+)-${sec}-`));
  return m ? m[1] : null;
};

const repos = existsSync(reposFile) ? readFileSync(reposFile, "utf8").split("\n").filter(Boolean) : [];
const activityRepos = repos.filter((r) => actOf(r, section));
const policy = loadPolicy("grader/assignments.json");

const gradedRepos = new Set();
if (existsSync("gradebook/grades.csv")) {
  const rows = parseCsv(readFileSync("gradebook/grades.csv", "utf8"));
  const H = rows.shift().reduce((m, h, i) => ((m[h] = i), m), {});
  for (const r of rows) if (r[H.repo]) gradedRepos.add(r[H.repo].toLowerCase());
}

const ungraded = activityRepos.filter((r) => !gradedRepos.has(r.toLowerCase()));
const byAct = {};
for (const r of ungraded) { const a = actOf(r, section); (byAct[a] ||= []).push(r); }
const activitiesWithRepos = [...new Set(activityRepos.map((r) => actOf(r, section)))].sort();
const notInPolicy = activitiesWithRepos.filter((a) => !policy.has(a));

const lines = [`# Activity-repo grading coverage - section ${section}`, "",
  `Every activity submission repo on ${org || "the org"} vs the gradebook. Read-only.`, ""];
lines.push(`- Activity submission repos: **${activityRepos.length}**  |  graded: **${activityRepos.length - ungraded.length}**  |  UNGRADED: **${ungraded.length}**`);
if (!repos.length) lines.push("- (!) The org repo list was empty - check the workflow's gh repo list step and the ORG_PAT scope.");
if (notInPolicy.length) lines.push(`- Activities that have repos but are NOT in assignments.json (sweep ignores them): **${notInPolicy.join(", ")}**`);
lines.push("");
if (ungraded.length) {
  lines.push("| activity | ungraded repos | in assignments.json? |", "| --- | --- | --- |");
  for (const a of Object.keys(byAct).sort()) lines.push(`| ${a} | ${byAct[a].length} (${byAct[a].slice(0, 6).join(", ")}${byAct[a].length > 6 ? ", ..." : ""}) | ${policy.has(a) ? "yes" : "**NO**"} |`);
  lines.push("");
} else lines.push("_All activity repos are graded._", "");

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join("\n"));
console.error(`${section}: repos ${activityRepos.length} | graded ${activityRepos.length - ungraded.length} | UNGRADED ${ungraded.length}${notInPolicy.length ? ` | not-in-policy: ${notInPolicy.join(",")}` : ""}`);
