#!/usr/bin/env node
// Author each section's Canvas assignments FROM grader/assignments.json.
//
// GitHub is the source of truth for what an activity is: its id, points, the
// lesson that teaches it, the starter repo, and how it is graded. This tool
// projects that onto Canvas so you never hand-build an assignment shell again.
// For every activity it creates (or updates) the matching Canvas assignment's
// name, description, Points Possible, and submission type, following one house
// standard (see docs/canvas-activities.md). On Canvas you then do exactly two
// things by hand: set the DUE DATE and PUBLISH. This tool never touches either.
//
// DRY RUN BY DEFAULT. It prints what it WOULD create/update and writes nothing
// to Canvas until you pass --execute.
//
// It is deliberately conservative so it can be re-run safely:
//   * It only ever touches Canvas assignments whose name maps to one of our
//     activity ids (by name token, or an explicit `canvasName` alias) - your
//     other Canvas assignments are left alone.
//   * CREATE builds the full standard shell (name, description, points,
//     submission type) for an activity Canvas does not have yet.
//   * UPDATE of an EXISTING assignment reconciles Points Possible only (and only
//     when the activity declares it) - it will NOT overwrite an existing
//     description or change a live submission type unless you opt in with --desc
//     / --submit. This keeps a re-run from clobbering assignments you hand-built
//     before adopting the standard.
//   * It NEVER renames an existing assignment unless you pass --rename, and it
//     NEVER sets due_at or published.
//
// Auth (never commit these):
//   CANVAS_BASE_URL   e.g. https://hau.instructure.com
//   CANVAS_TOKEN      a Canvas access token with assignment-write rights
//
// Env baked into the section workflow (override with the matching flag):
//   CANVAS_COURSE_ID  the Canvas course           (--course=<id>)
//   GRADE_OWNER       the GitHub org, for repo links  (--org=<org>)
//   WORKSPACE_PREFIX  e.g. student-6xxx-0000-       (--workspace-prefix=<p>)
//
// Usage:
//   node tools/canvas-sync-assignments.mjs [--course=<id>] [--org=<org>]
//        [--workspace-prefix=<p>] [--only=<id>] [--rename] [--execute]

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeIdResolver, loadPolicy } from "./lib/gradebook.mjs";

// ---- args / env ----------------------------------------------------------
const arg = (name, def = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const org = arg("org") || process.env.GRADE_OWNER || "";
const workspacePrefix = arg("workspace-prefix") || process.env.WORKSPACE_PREFIX || "";
const onlyId = arg("only");
const doRename = flag("rename");
const doDesc = flag("desc");        // also (re)write the description on an update
const doSubmit = flag("submit");    // also enforce the submission type on an update
const moduleName = arg("module", "SUBMISSIONS");   // Canvas module every managed activity lands in
const execute = flag("execute");
const reportPath = arg("report", "gradebook/canvas-sync-report.md");

const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID in the env or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }

// ---- Canvas REST client (same shape as canvas-push.mjs) ------------------
const api = async (path, init = {}) => {
  const url = path.startsWith("http") ? path : `${BASE}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}: ${(await res.text()).slice(0, 300)}`);
  return res;
};
const apiGetAll = async (path) => {
  let url = `${BASE}/api/v1${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const out = [];
  while (url) {
    const res = await api(url);
    out.push(...(await res.json()));
    const next = (res.headers.get("link") || "").split(",").find((s) => s.includes('rel="next"'));
    url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
  }
  return out;
};

// ---- description standard (docs/canvas-activities.md) ---------------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A plain-text body (grader/<id>/CANVAS.md) -> simple HTML: blank lines split
// paragraphs, single newlines become <br>.
const bodyToHtml = (text) =>
  text.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("\n");

const family = (a) =>
  a.type === "quiz" || a.submit === "canvas" ? "quiz"
  : a.manual || a.submit === "url" ? "manual"
  : "repo";

const readActivityFile = (id, file) => {
  const p = `grader/${id}/${file}`;
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

// Build the standard description: Summary / Repo / Content / Instructions /
// Submission & grading. Slots that do not apply to a family are omitted.
function buildDescription(a) {
  const fam = family(a);
  const parts = [];
  if (a.title) parts.push(`<p><strong>${esc(a.title)}</strong></p>`);

  if (fam === "repo") {
    if (org) {
      const url = `https://github.com/${org}/${a.id}-classcode-yourname`;
      parts.push(`<p><strong>Repo:</strong> start from the template <a href="${url}">${a.id}-classcode-yourname</a> (Use this template), then push your work to submit.</p>`);
    }
  }

  if (a.content) {
    const ws = workspacePrefix ? `<code>${esc(workspacePrefix)}&lt;you&gt;</code>` : "your workspace repo";
    parts.push(`<p><strong>Content:</strong> the lesson is in <code>content/${esc(a.content)}/</code> in ${ws}. Read it before you start.</p>`);
  }

  const body = readActivityFile(a.id, "CANVAS.md");
  if (body) parts.push(`<p><strong>Instructions</strong></p>`, bodyToHtml(body));

  // Submission & grading line, per family + score source.
  const pts = a.totalPoints ?? a.autoPoints ?? null;
  const grade = [];
  if (fam === "manual") {
    grade.push("Submit by pasting your live link as the submission (no repo, no upload).");
    grade.push(existsSync(`grader/${a.id}/RUBRIC.md`) ? "Graded on a rubric, generously." : "Graded on completion.");
  } else if (fam === "repo") {
    grade.push("Submit by pushing to your GitHub repo; the autograder checks it on every push.");
    grade.push(a["ai-grading"] ? "Score: automated tests plus a design rubric." : "Score: automated tests (each test maps to points).");
  } else {
    grade.push("This activity is taken in Canvas.");
  }
  if (pts != null) grade.push(`Worth ${pts} point${pts === 1 ? "" : "s"}.`);
  parts.push(`<p><strong>Submission &amp; grading:</strong> ${grade.join(" ")}</p>`);

  return parts.join("\n");
}

// Desired Canvas shape for an activity (name/description/points/submission).
function desired(a) {
  const fam = family(a);
  const idU = a.id.toUpperCase();
  const name = a.title ? `${idU}: ${a.title}` : idU;
  const pts = a.totalPoints ?? a.autoPoints ?? null;   // null -> do not set
  const submission_types =
    fam === "manual" ? ["online_url"]
    : fam === "repo" ? ["none"]          // graded via canvas-push, not a Canvas upload
    : null;                              // quiz: leave to the QTI import
  return { name, description: buildDescription(a), points: pts, submission_types, fam };
}

// ---- load activities + live Canvas assignments ---------------------------
const activities = JSON.parse(readFileSync("grader/assignments.json", "utf8"))
  .filter((a) => !onlyId || a.id === onlyId);
const canvas = await apiGetAll(`/courses/${courseId}/assignments`);
const byId = new Map();
// Resolve against the FULL policy, not the --only filter: an alias declared on
// any activity must still be honored when adopting live Canvas assignments.
const resolveId = makeIdResolver(loadPolicy("grader/assignments.json"));
for (const c of canvas) { const id = resolveId(c.name); if (id && !byId.has(id)) byId.set(id, c); }

console.log(`canvas-sync: course ${courseId} on ${BASE} (${execute ? "EXECUTE" : "dry run"})`);

// The "SUBMISSIONS" module every managed activity should live under. If the
// instructor has not created it yet, module placement is skipped with a warning
// (the assignment sync itself still runs).
const modules = await apiGetAll(`/courses/${courseId}/modules`);
const targetModule = modules.find((m) => m.name.trim().toLowerCase() === moduleName.trim().toLowerCase());
const moduleItemContentIds = new Set();
if (targetModule) {
  for (const it of await apiGetAll(`/courses/${courseId}/modules/${targetModule.id}/items`)) {
    if (it.type === "Assignment" && it.content_id != null) moduleItemContentIds.add(+it.content_id);
  }
}

const plan = { create: [], update: [], quizSkip: [], noop: [], addToModule: [] };
for (const a of activities) {
  const d = desired(a);
  if (d.fam === "quiz") { plan.quizSkip.push({ id: a.id }); continue; }
  const existing = byId.get(a.id);
  if (!existing) { plan.create.push({ a, d }); continue; }

  // UPDATE is conservative: points always reconcile (when declared); name,
  // description, and submission type only with their opt-in flag, so a re-run
  // never clobbers an assignment authored before the standard.
  const changes = [];
  if (doRename && existing.name !== d.name) changes.push(`name "${existing.name}" -> "${d.name}"`);
  if (d.points != null && +existing.points_possible !== +d.points) changes.push(`points ${existing.points_possible} -> ${d.points}`);
  if (doSubmit && d.submission_types && (existing.submission_types || []).join(",") !== d.submission_types.join(","))
    changes.push(`submit ${(existing.submission_types || []).join(",")} -> ${d.submission_types.join(",")}`);
  if (doDesc && (existing.description || "").trim() !== d.description.trim()) changes.push("description");

  if (changes.length) plan.update.push({ a, d, existing, changes });
  else plan.noop.push({ id: a.id });

  // Existing assignment not yet under SUBMISSIONS -> plan to add it.
  if (targetModule && !moduleItemContentIds.has(+existing.id)) plan.addToModule.push({ id: a.id, contentId: existing.id, name: existing.name });
}

// Fold of the old assignment-sync audit: Canvas assignments whose name maps to
// one of our activity ids but that id is NOT in assignments.json (an activity
// removed from policy, or an id drift) - candidates to hide/delete in Canvas.
// Uses the FULL policy (not the --only filter). Read-only signal.
const policyIds = new Set(JSON.parse(readFileSync("grader/assignments.json", "utf8")).map((a) => a.id));
const canvasOnly = [...byId.entries()].filter(([id]) => !policyIds.has(id)).map(([id, c]) => ({ id, name: c.name }));

// ---- report --------------------------------------------------------------
const moduleState = targetModule ? `found (adds ${plan.addToModule.length + plan.create.length})` : `**NOT FOUND - create a "${moduleName}" module in Canvas; module placement skipped**`;
const md = [
  `# Canvas assignment sync - course ${courseId}`,
  "",
  `- Mode: **${execute ? "EXECUTE (Canvas written)" : "dry run (nothing written)"}**`,
  `- Activities: **${activities.length}**  |  create: **${plan.create.length}**, update: **${plan.update.length}**, unchanged: **${plan.noop.length}**, quizzes skipped: **${plan.quizSkip.length}**`,
  `- Canvas assignments with NO policy activity: **${canvasOnly.length}**`,
  `- Module "${moduleName}": ${moduleState}`,
  "",
  "> Due date and published state are never set by this tool - set them in Canvas.",
  "",
];
if (plan.create.length) {
  md.push("## Create", "", "| activity | name | pts | submit |", "| --- | --- | --- | --- |");
  md.push(...plan.create.map(({ a, d }) => `| ${a.id} | ${d.name} | ${d.points ?? "-"} | ${(d.submission_types || ["-"]).join(",")} |`), "");
}
if (plan.update.length) {
  md.push("## Update", "", "| activity | changes |", "| --- | --- |");
  md.push(...plan.update.map(({ a, changes }) => `| ${a.id} | ${changes.join("; ")} |`), "");
}
if (targetModule && (plan.addToModule.length || plan.create.length)) {
  md.push(`## Add to "${moduleName}" module`, "");
  md.push(...plan.addToModule.map((x) => `- ${x.id} (${x.name})`));
  md.push(...plan.create.map(({ a, d }) => `- ${a.id} (${d.name}) - after it is created`), "");
}
if (plan.quizSkip.length) md.push("## Skipped - quizzes (imported via QTI, not authored here)", "", ...plan.quizSkip.map((q) => `- ${q.id}`), "");
if (canvasOnly.length) md.push("## Canvas assignments with NO policy activity (hide/delete in Canvas, or reconcile the id)", "", ...canvasOnly.map((c) => `- ${c.id} ("${c.name}")`), "");
if (plan.noop.length) md.push(`_Unchanged: ${plan.noop.map((n) => n.id).join(", ")}_`, "");

console.log(`  create ${plan.create.length}, update ${plan.update.length}, unchanged ${plan.noop.length}, quiz-skip ${plan.quizSkip.length}; module ${targetModule ? "ok" : "MISSING"}`);
if (!targetModule) console.log(`  ! module "${moduleName}" not found - assignments still sync, but create it to place them`);

// ---- execute (or stop at the dry run) ------------------------------------
if (!execute) {
  md.unshift("> Dry run - nothing was written. Re-run with --execute to apply.", "");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, md.join("\n") + "\n");
  console.log(`  DRY RUN - report: ${reportPath}  (re-run with --execute to apply)`);
  process.exit(0);
}

// A create makes an UNPUBLISHED assignment (published:false) so nothing shows to
// students until you publish it. Updates never send published or due_at.
let created = 0, updated = 0, moduled = 0;
const toModule = [...plan.addToModule];   // {contentId, name}; created ones appended below
for (const { a, d } of plan.create) {
  const assignment = { name: d.name, description: d.description, published: false };
  if (d.points != null) assignment.points_possible = d.points;
  if (d.submission_types) assignment.submission_types = d.submission_types;
  const res = await api(`/courses/${courseId}/assignments`, { method: "POST", body: JSON.stringify({ assignment }) });
  const made = await res.json();
  created++;
  console.log(`  created ${d.name}`);
  if (targetModule && made.id != null && !moduleItemContentIds.has(+made.id)) toModule.push({ id: a.id, contentId: made.id, name: d.name });
}
for (const { d, existing, changes } of plan.update) {
  // Send only the fields that were actually planned as changes, so a points-only
  // reconcile never clobbers the description or submission type.
  const assignment = {};
  if (doRename && existing.name !== d.name) assignment.name = d.name;
  if (d.points != null && +existing.points_possible !== +d.points) assignment.points_possible = d.points;
  if (doSubmit && d.submission_types) assignment.submission_types = d.submission_types;
  if (doDesc) assignment.description = d.description;
  await api(`/courses/${courseId}/assignments/${existing.id}`, { method: "PUT", body: JSON.stringify({ assignment }) });
  updated++;
  console.log(`  updated ${existing.name} (${changes.join("; ")})`);
}
for (const x of toModule) {
  await api(`/courses/${courseId}/modules/${targetModule.id}/items`, {
    method: "POST",
    body: JSON.stringify({ module_item: { type: "Assignment", content_id: x.contentId } }),
  });
  moduled++;
  console.log(`  added ${x.name} to "${moduleName}"`);
}
md.unshift(`> EXECUTED - created ${created}, updated ${updated}, module-added ${moduled}.`, "");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, md.join("\n") + "\n");
console.log(`  EXECUTED: created ${created}, updated ${updated}, module-added ${moduled} - see ${reportPath}`);
