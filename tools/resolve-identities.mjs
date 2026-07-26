#!/usr/bin/env node
// Resolve blank / wrong studentNumber rows for THIS section (e.g. a student
// pasted their EMAIL into the number field, splitting one activity into its own
// gradebook row).
//
// Groups a student's repos by REPO HANDLE (the suffix after m1a1-<section>-),
// which is the same student's own namespace, so it never merges two different
// students who share a surname. Per handle group:
//   - TYPO-SPLIT: 2+ different numbers but only ONE is a real Canvas enrollment
//     -> the others are typos; fix the typo repos to the Canvas number.
//   - SAFE-FILL: one valid Canvas number + blank/invalid rows -> copy the good
//     student.json from a sibling into the bad repo.
//   - TWO-STUDENTS / NOT-ON-CANVAS / AMBIGUOUS: reported for a human, never fixed.
//
// The Canvas roster (needed to tell a typo from two real students) is fetched
// inline (CANVAS_COURSE_ID). DRY RUN by default; --execute writes the SAFE-FILL/
// TYPO fixes into the student submission repos as course-bot (needs
// GH_TOKEN=ORG_PAT). Output: reports/identity-fixes.md.
//
// Usage:
//   node tools/resolve-identities.mjs [--section=<code>] [--org=<org>]
//                                     [--course=<id>] [--execute] [--report=<path>]

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseCsv, normNum, repoStem } from "./lib/gradebook.mjs";

const arg = (name, def = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const section = arg("section") || process.env.SECTION || "";
const org = arg("org") || process.env.GRADE_OWNER || "";
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const reportPath = arg("report", "reports/identity-fixes.md");
const EXECUTE = flag("execute");
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const CB = "course-bot@users.noreply.github.com";
if (!section) { console.error("no section: set SECTION in the env or pass --section=<code>"); process.exit(1); }
if (!org) { console.error("no org: set GRADE_OWNER"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID"); process.exit(1); }

async function canvasGet(path) {
  const out = [];
  let url = `${BASE}/api/v1${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
    out.push(...(await res.json()));
    const next = (res.headers.get("link") || "").split(",").find((p) => p.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
  }
  return out;
}
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const validNum = (s) => /^\d{6,}$/.test(String(s || "").trim());
const norm = (s) => String(s ?? "").toLowerCase().replace(/[.,]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
const overlap = (a, b) => { const B = new Set(norm(b).split(" ")); let n = 0; for (const t of norm(a).split(" ")) if (B.has(t)) n++; return n; };

// ---- Canvas roster (inline) ----------------------------------------------
const users = await canvasGet(`/courses/${courseId}/users?enrollment_type[]=student&include[]=enrollments&include[]=email`);
const roster = users.map((u) => ({ name: u.sortable_name || u.name, studentNumber: u.sis_user_id || "", login: u.login_id || "", email: u.email || "" }));
const rosterNums = new Set(roster.map((r) => normNum(r.studentNumber)));

// ---- gradebook -----------------------------------------------------------
if (!existsSync("gradebook/grades.csv")) { console.error("no gradebook/grades.csv - nothing to resolve"); process.exit(0); }
const rows = parseCsv(readFileSync("gradebook/grades.csv", "utf8"));
const H = rows.shift().reduce((m, h, i) => ((m[h] = i), m), {});

const L = [`# Identity fixes (blank / wrong studentNumber) - section ${section}`, "", EXECUTE ? "MODE: EXECUTE" : "MODE: dry-run", ""];
let safe = [], twoStudents = 0, ambiguous = 0, notcanvas = 0, applied = 0;

// group rows by repo handle (student's own namespace)
const groups = new Map();
for (const r of rows) {
  const handle = (repoStem(r[H.repo], section) || r[H.repo] || "").toLowerCase();
  if (!groups.has(handle)) groups.set(handle, []);
  groups.get(handle).push(r);
}
for (const [handle, list] of groups) {
  const goodNums = [...new Set(list.map((r) => normNum(r[H.studentNumber])).filter(validNum))];
  const badRows = list.filter((r) => !validNum(normNum(r[H.studentNumber])));

  if (goodNums.length > 1) {
    const onCanvas = goodNums.filter((n) => rosterNums.has(n));
    if (onCanvas.length === 1) {                          // TYPO-SPLIT -> fixable
      const correct = onCanvas[0];
      const goodRepo = list.find((r) => normNum(r[H.studentNumber]) === correct)[H.repo];
      for (const r of list) {
        if (normNum(r[H.studentNumber]) !== correct)
          safe.push({ badRepo: r[H.repo], goodRepo, num: correct, act: r[H.assignment], had: r[H.studentNumber] || "blank", kind: "typo" });
      }
    } else if (onCanvas.length >= 2) {                    // TWO-STUDENTS -> never merge
      twoStudents++;
      L.push(`## TWO-STUDENTS ${section}/${handle} - ${onCanvas.length} different Canvas enrollments (${onCanvas.join(", ")}) - left alone (verify by hand)`, "");
      for (const r of list) L.push(`- ${r[H.repo]}  num='${r[H.studentNumber]}'  gh=${r[H.githubAccount]}`);
      L.push("");
    } else {                                              // none on Canvas -> can't pick
      ambiguous++;
      L.push(`## AMBIGUOUS ${section}/${handle} - numbers (${goodNums.join(", ")}) none on Canvas - fix by hand`, "");
    }
    continue;
  }

  if (!badRows.length) continue;                          // single consistent number, no blanks -> fine
  if (goodNums.length === 1) {                            // one real number + blank rows
    const num = goodNums[0];
    const goodRepo = list.find((r) => normNum(r[H.studentNumber]) === num)[H.repo];
    const onCanvas = rosterNums.has(num);
    const badList = badRows.map((r) => `${r[H.repo]} (${r[H.assignment]}, num='${r[H.studentNumber]}')`);
    if (!onCanvas) {
      notcanvas++;
      const best = roster.map((rs) => ({ rs, ov: overlap(list[0][H.fullName], rs.name) })).sort((a, b) => b.ov - a.ov)[0];
      L.push(`## NOT-ON-CANVAS ${section}/${handle} num ${num} - fix by hand`, `- bad rows: ${badList.join("; ")}`, `- best Canvas name match: ${best?.ov ? `#${best.rs.studentNumber} "${best.rs.name}"` : "none"}`, "");
      continue;
    }
    for (const r of badRows) safe.push({ badRepo: r[H.repo], goodRepo, num, act: r[H.assignment], had: r[H.studentNumber], kind: "blank" });
  } else {                                                // no valid number anywhere for this handle
    L.push(`## ALL-BLANK ${section}/${handle} - no number in any repo (needs roster)`, `- ${badRows.map((r) => r[H.repo]).join(", ")}`, "");
  }
}

const typos = safe.filter((f) => f.kind === "typo").length;
L.splice(3, 0, `FIXABLE: ${safe.length} (typo-split ${typos}, blank ${safe.length - typos}) | TWO-STUDENTS: ${twoStudents} | NOT-ON-CANVAS: ${notcanvas} | AMBIGUOUS: ${ambiguous}`, "");
L.push("## FIXABLE (copy good student.json from a sibling)", "", "| fix repo | activity | kind | had | -> number | source repo |", "| --- | --- | --- | --- | --- | --- |");
for (const f of safe) L.push(`| ${f.badRepo} | ${f.act} | ${f.kind} | '${f.had}' | ${f.num} | ${f.goodRepo} |`);

if (EXECUTE) {
  for (const f of safe) {
    try {
      const content = gh(["api", `repos/${org}/${f.goodRepo}/contents/student.json`, "-q", ".content"]).replace(/\s/g, "");
      const sha = gh(["api", `repos/${org}/${f.badRepo}/contents/student.json`, "-q", ".sha"]).trim();
      const msg = f.kind === "typo"
        ? ":pencil2: Fix typo'd studentNumber (duplicate row) - verified vs sibling + Canvas"
        : ":pencil2: Backfill student.json identity - verified vs sibling + Canvas";
      gh(["api", "-X", "PUT", `repos/${org}/${f.badRepo}/contents/student.json`,
        "-f", `message=${msg}`,
        "-f", `content=${content}`, "-f", `sha=${sha}`,
        "-f", "committer[name]=course-bot", "-f", `committer[email]=${CB}`,
        "-f", "author[name]=course-bot", "-f", `author[email]=${CB}`, "-q", ".commit.sha"]);
      applied++;
      console.error(`fixed ${f.badRepo} (${f.kind}) -> ${f.num}`);
    } catch (e) { console.error(`FAILED ${f.badRepo}: ${String(e.message).slice(0, 80)}`); }
  }
  L.push("", `Applied ${applied}/${safe.length} fixes.`);
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, L.join("\n"));
console.error(`${section}: FIXABLE ${safe.length} (typo ${typos}) | TWO-STUDENTS ${twoStudents} | NOT-ON-CANVAS ${notcanvas} | AMBIGUOUS ${ambiguous}${EXECUTE ? ` | applied ${applied}` : ""}`);
