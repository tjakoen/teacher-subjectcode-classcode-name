#!/usr/bin/env node
// Flip an ACTIVITY TEMPLATE or SOLUTION repo between public and private.
//
// Releasing an activity means making its template repo public so students can
// "Use this template"; retiring one means putting it back. Nothing in the engine
// could do that, so it was a manual trip to each repo's settings page, and the
// state was invisible from anywhere else. This is that one flip, over the API,
// dry-run by default.
//
// THIS IS ORG-WIDE BY DESIGN. Template and solution repos are not section-scoped
// the way workspaces are: one m5a5-classcode-yourname serves every section in the
// org. So unlike publish/provision/attendance, this tool has no SECTION lock, and
// a flip here is visible to every class in the org. That is the intent, not an
// oversight - but it is also why the name guard below is absolute.
//
// WHAT IT REFUSES TO TOUCH. Only names that are unmistakably infrastructure: an
// activity template (<id>-classcode-yourname), a worked solution (<id>-solution),
// a named template repo (<something>-template) or an in-class demo (*live-demo*).
// Everything else is rejected before a single request goes out. A student
// submission or workspace repo carries graded work, student.json and delivered
// grades; making one public is a PII incident, and a typo in a repo name must not
// be able to cause it.
//
// SOLUTIONS ARE PRIVATE BY DEFAULT, AND STAY THAT WAY. A solution repo is the
// worked answer. Making one public needs --allow-solution-public on top of
// --execute, so it can never be a slip of the argument list. (The m1a1 solutions
// are deliberately public as the platform's authoring examples; that is the
// exception the extra flag exists to express.)
//
// Auth: GH_TOKEN (the ORG_PAT secret in Actions) needs Administration: write on
// the org's repos, which is a bigger scope than the rest of the engine uses. That
// is exactly why this runs here, in a workflow, and not in the browser: the token
// stays a repo secret, and every flip leaves an Actions log behind.
//
// Usage:
//   node tools/repo-visibility.mjs --repo=m6a1-classcode-yourname --visibility=public
//   node tools/repo-visibility.mjs --repo=m6a1-classcode-yourname,m6a2-classcode-yourname --visibility=public --execute
//   node tools/repo-visibility.mjs --repo=m5a5-solution --visibility=public --execute --allow-solution-public
//
// Options:
//   --repo=<names>       REQUIRED. Comma-separated repo names (no org prefix).
//   --visibility=<v>     REQUIRED. "public" or "private".
//   --org=<org>          defaults to $ORG, then the running repo's owner.
//   --execute            actually write; otherwise dry run.
//   --allow-solution-public   required to make a *-solution repo public.

import { execSync } from "node:child_process";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const execute = process.argv.includes("--execute");
const allowSolutionPublic = process.argv.includes("--allow-solution-public");
const org = arg("org") || process.env.ORG || process.env.GITHUB_REPOSITORY_OWNER || "";
const visibility = String(arg("visibility") || "").toLowerCase();
const names = (arg("repo") || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!org) { console.error("no org: set ORG or pass --org=<org>"); process.exit(1); }
if (!names.length) { console.error("no repos: pass --repo=<name>[,<name>...]"); process.exit(1); }
if (visibility !== "public" && visibility !== "private") {
  console.error(`--visibility must be "public" or "private" (got ${JSON.stringify(arg("visibility"))})`);
  process.exit(1);
}
const wantPrivate = visibility === "private";

// Token: the workflow env in Actions, the gh CLI's own token locally.
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
if (!token) {
  try { token = execSync("gh auth token", { encoding: "utf8" }).trim(); }
  catch { console.error("no token: set GH_TOKEN or log in with gh"); process.exit(1); }
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// The name guard. Deliberately a whitelist: anything that is not obviously an
// activity template, a worked solution, a named template or a demo is rejected,
// rather than trying to enumerate every shape a student repo can take.
const isSolution = (n) => /-solution$/i.test(n);
const isActivityTemplate = (n) => /-classcode-yourname$/i.test(n);
const isNamedTemplate = (n) => /-template$/i.test(n) && !/^(student|teacher)-/i.test(n);
const isDemo = (n) => /live-demo/i.test(n);
const allowed = (n) => isSolution(n) || isActivityTemplate(n) || isNamedTemplate(n) || isDemo(n);

const rejected = names.filter((n) => !allowed(n));
if (rejected.length) {
  console.error("REFUSING: these are not activity template / solution / demo repos:");
  rejected.forEach((n) => console.error(`  ${n}`));
  console.error("Only <id>-classcode-yourname, <id>-solution, <name>-template and *live-demo* repos can be flipped here.");
  console.error("Student submission and workspace repos hold graded work and student.json - making one public is a PII incident.");
  process.exit(1);
}

const exposing = names.filter((n) => isSolution(n) && !wantPrivate);
if (exposing.length && !allowSolutionPublic) {
  console.error("REFUSING: making a solution repo public needs --allow-solution-public as well:");
  exposing.forEach((n) => console.error(`  ${n}`));
  console.error("A solution repo is the worked answer. Publishing one is a decision, not a default.");
  process.exit(1);
}

console.log(`Repo visibility - ${org} - target: ${visibility}${execute ? "" : "   [DRY RUN]"}`);
console.log("This is ORG-WIDE: every class in this org sees the same template and solution repos.\n");

let changed = 0, already = 0, failed = 0;
for (const name of names) {
  const cur = await api(`/repos/${org}/${name}`);
  if (!cur.ok) {
    console.log(`  ${name}: NOT FOUND (${cur.status}) - skipped`);
    failed++;
    continue;
  }
  const now = cur.body.private ? "private" : "public";
  const kind = isSolution(name) ? "solution" : "template";
  const flag = cur.body.is_template ? "" : (isActivityTemplate(name) || isNamedTemplate(name) ? "   [template flag is OFF]" : "");
  if (cur.body.private === wantPrivate) {
    console.log(`  ${name}: already ${now} (${kind})${flag}`);
    already++;
    continue;
  }
  if (!execute) {
    console.log(`  ${name}: ${now} -> ${visibility} (${kind})${flag}`);
    if (!wantPrivate) console.log(`      going PUBLIC: anyone on the internet will be able to read this repo.`);
    changed++;
    continue;
  }
  const res = await api(`/repos/${org}/${name}`, { method: "PATCH", body: JSON.stringify({ private: wantPrivate }) });
  if (!res.ok) {
    const hint = res.status === 403 ? " (does the token have Administration: write on this org?)" : "";
    console.log(`  ${name}: FAILED ${res.status} ${res.body.message || ""}${hint}`);
    failed++;
    continue;
  }
  // Read it back rather than trusting the PATCH response: this is the only
  // record that the flip actually took.
  const after = await api(`/repos/${org}/${name}`);
  const got = after.ok ? (after.body.private ? "private" : "public") : "unreadable";
  console.log(`  ${name}: ${now} -> ${got}${got === visibility ? " OK" : "   MISMATCH - check it by hand"}`);
  if (got === visibility) changed++; else failed++;
}

console.log(`\n${execute ? "Changed" : "Would change"}: ${changed}   already ${visibility}: ${already}   failed: ${failed}`);
if (!execute && changed) console.log("Re-run with --execute to apply.");
if (failed) process.exit(1);
