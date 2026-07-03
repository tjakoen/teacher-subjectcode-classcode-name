#!/usr/bin/env node
// Cross-org repo hygiene audit. Read-only: it classifies every repo in each org
// and proposes actions - it never renames or deletes anything itself.
//
// Catches what we've actually seen: malformed activity names that don't grade
// (org prefix, underscores, `m3-a2`, wrong/again-typed section), duplicate
// submissions, identity collisions (two repos, same student number), junk/test/
// sample repos, and blank student.json.
//
// Usage:
//   node tools/org-audit.mjs [ORG ...]
//   Orgs come from CLI args, else the `orgs` array in course.config.json.
//   (uses your `gh` login for the API token)

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const loadConfig = () => {
  try {
    return JSON.parse(readFileSync(new URL("../course.config.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
};

const ORGS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (loadConfig().orgs || []);
if (!ORGS.length) {
  console.error("No orgs to audit: pass them as args or set `orgs` in course.config.json");
  process.exit(1);
}
const token = execSync("gh auth token", { encoding: "utf8" }).trim();

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
};
const listOrgRepos = async (org) => {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await api(`/orgs/${org}/repos?per_page=100&page=${page}`);
    if (!r || !r.length) break;
    out.push(...r.map((x) => x.name));
  }
  return out;
};
async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx]); }
  }));
  return res;
}
const readStudent = async (org, repo) => {
  try {
    const r = await api(`/repos/${org}/${repo}/contents/student.json`);
    if (!r || !r.content) return null;
    return JSON.parse(Buffer.from(r.content, "base64").toString("utf8"));
  } catch { return null; }
};

const isTemplate = (n) => /-classcode-yourname$/i.test(n);
const isSolution = (n) => /(^|-)solution$/i.test(n) || /-solution-/i.test(n);
const isTeacher  = (n) => /^teacher-/i.test(n);
const isDemo     = (n) => /live-demo|demo-/i.test(n);
const isSample   = (n) => /octocat|sample/i.test(n);
const actOK      = (n) => n.match(/^(m\d+a\d+)-(\d{4})-(.+)$/i);
const wsOK       = (n) => n.match(/^student-[a-z0-9]+-(\d{4})-(.+)$/i);
const actish     = (n) => /^m\d+a\d+/i.test(n);
const num = (s) => (s && s.studentNumber ? String(s.studentNumber).trim().replace(/^\d{4}-/, "") : "");
const gh  = (s) => (s && s.githubAccount ? String(s.githubAccount).trim().toLowerCase() : "");

for (const org of ORGS) {
  const names = await listOrgRepos(org);
  const cats = { keep: [], sample: [], malformed: [], junk: [], activity: [], workspace: [] };
  for (const n of names) {
    if (isTemplate(n) || isSolution(n) || isTeacher(n) || isDemo(n)) cats.keep.push(n);
    else if (isSample(n)) cats.sample.push(n);
    else if (actOK(n)) cats.activity.push(n);
    else if (wsOK(n)) cats.workspace.push(n);
    else if (actish(n)) cats.malformed.push(n);
    else cats.junk.push(n);
  }
  const toRead = [...cats.activity, ...cats.malformed, ...cats.junk];
  const ids = {};
  (await pool(toRead, 8, (r) => readStudent(org, r))).forEach((s, k) => { ids[toRead[k]] = s; });

  // group activity repos by (activity, section, student number)
  const byKey = {};
  for (const n of cats.activity) {
    const m = actOK(n);
    if (num(ids[n])) (byKey[`${m[1].toLowerCase()}|${m[2]}|${num(ids[n])}`] ||= []).push(n);
  }
  const dups = Object.values(byKey).filter((a) => a.length > 1);

  console.log(`\n================ ${org} (${names.length} repos) ================`);
  console.log(`keep: ${cats.keep.length} | activity: ${cats.activity.length} | workspace: ${cats.workspace.length}`);
  if (cats.sample.length)   { console.log(`\nDELETE - samples:`); cats.sample.forEach((n) => console.log(`  ${n}`)); }
  if (cats.junk.length)     { console.log(`\nDELETE/RENAME - junk / non-standard:`); cats.junk.forEach((n) => console.log(`  ${n}   [num=${num(ids[n]) || "-"} gh=${gh(ids[n]) || "-"}]`)); }
  if (cats.malformed.length){ console.log(`\nRENAME - malformed activity repos:`); cats.malformed.forEach((n) => { const act = (n.match(/^(m\d+a\d+)/i) || [])[1]?.toLowerCase(); console.log(`  ${n}   ->  ${act}-${ids[n]?.classCode || "????"}-${gh(ids[n]) || "UNKNOWN"}   [num=${num(ids[n]) || "-"}]`); }); }
  if (dups.length) {
    console.log(`\nDUPLICATE / COLLISION (same number, check names differ = collision):`);
    for (const a of dups) {
      const names2 = a.map((n) => `${n}(${(ids[n]?.fullName || "?").trim()})`);
      console.log(`  ${names2.join("  ==  ")}`);
    }
  }
  const blanks = cats.activity.filter((n) => !num(ids[n]) && !gh(ids[n]));
  if (blanks.length) console.log(`\nBLANK student.json on real activity repos: ${blanks.length} (most are rescued by consolidation; the push report is the source of truth for who is actually unmatched)`);
}


// ======================== ACCESS AUDIT ========================
// Who can reach what. Policy: the ORG owns every repo (so the engine can grade
// and deliver), but each student is the legitimate ADMIN of their OWN repos.
// Only teachers may be org owners or hold admin on infrastructure repos, and no
// student should reach another student's repo. Signals are collaborator-based
// (ground truth), not name-based, because repo-name handles and student.json
// rarely equal the real GitHub login. Flags: rogue org owners, non-teacher
// access on teacher/solution/template/demo repos, a student repo shared with
// 2+ non-teacher accounts (possible peer access), a workspace with no student
// collaborator at all (nobody can see delivered grades), and permissive org
// base permissions.
await (async () => {
  const TEACHERS = new Set((loadConfig().teachers || []).map((t) => String(t).toLowerCase()));
  const gql = async (query, variables) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`graphql ${res.status}`);
    const j = await res.json();
    if (j.errors) throw new Error(`graphql: ${j.errors.map((e) => e.message).join("; ")}`);
    return j.data;
  };
  const ACCESS_QUERY = `
    query($org:String!, $cursor:String) {
      organization(login:$org) {
        repositories(first:50, after:$cursor, ownerAffiliations: OWNER) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            collaborators(affiliation: DIRECT, first: 100) { edges { permission node { login } } }
          }
        }
      }
    }`;

  console.log(`\n########################  ACCESS AUDIT  ########################`);
  if (!TEACHERS.size) console.log("(!) no teachers configured - set `teachers` in course.config.json, or every admin looks foreign");

  for (const org of ORGS) {
    const meta = await api(`/orgs/${org}`);
    const base = meta?.default_repository_permission || "?";
    const admins = (await api(`/orgs/${org}/members?role=admin`)) || [];
    const rogueOwners = admins.map((a) => a.login).filter((l) => !TEACHERS.has(l.toLowerCase()));

    const repos = [];
    let cursor = null;
    do {
      let d;
      try { d = await gql(ACCESS_QUERY, { org, cursor }); }
      catch (e) { console.error(`  ! ${org}: access query failed (${e.message})`); break; }
      const page = d?.organization?.repositories;
      if (!page) break;
      for (const r of page.nodes) {
        repos.push({
          name: r.name,
          collabs: (r.collaborators?.edges || []).map((e) => ({ login: e.node.login.toLowerCase(), perm: e.permission })),
        });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    const infraAccess = [], shared = [], orphan = [];
    for (const r of repos) {
      const nonTeacher = r.collabs.filter((c) => !TEACHERS.has(c.login));
      if (isTeacher(r.name) || isSolution(r.name) || isTemplate(r.name) || isDemo(r.name)) {
        nonTeacher.forEach((c) => infraAccess.push(`${r.name}  <- ${c.login} (${c.perm})`));
        continue;
      }
      const isWs = !!wsOK(r.name);
      if (!isWs && !actOK(r.name)) continue; // hygiene pass covers junk/malformed
      const people = [...new Set(nonTeacher.map((c) => c.login))];
      if (people.length >= 2) shared.push(`${r.name}  <- ${nonTeacher.map((c) => `${c.login}(${c.perm})`).join(", ")}`);
      if (isWs && people.length === 0) orphan.push(r.name);
    }

    console.log(`\n---------------- ${org} ----------------`);
    console.log(`members' base repo permission: ${base}${base !== "none" && base !== "?" ? "   (!) members can reach repos they are not collaborators on" : ""}`);
    console.log(rogueOwners.length ? `ROGUE ORG OWNERS (should be teachers only): ${rogueOwners.join(", ")}` : "org owners: teachers only");
    if (infraAccess.length) { console.log(`NON-TEACHER ACCESS on infrastructure repos (${infraAccess.length}):`); infraAccess.forEach((s) => console.log(`  ${s}`)); }
    if (shared.length) { console.log(`SHARED ACCESS - student repo with 2+ non-teacher accounts, a peer may see it (${shared.length}):`); shared.forEach((s) => console.log(`  ${s}`)); }
    if (orphan.length) { console.log(`NO STUDENT ACCESS - workspace has no student collaborator, delivered grades are invisible (${orphan.length}):`); orphan.forEach((s) => console.log(`  ${s}`)); }
    if (!infraAccess.length && !shared.length && !orphan.length && !rogueOwners.length) console.log("access: clean");
  }
})();
