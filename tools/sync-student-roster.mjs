#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { buildStudentRoster, reconcileStudentRoster, canvasRoster, canvasRosterJson } from "./lib/student-roster.mjs";

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const section = process.env.SECTION || arg("section");
const owner = process.env.GRADE_OWNER;
const prefix = process.env.WORKSPACE_PREFIX?.toLowerCase();
const snapshot = arg("from-snapshot");
if (!section || (!snapshot && (!owner || !prefix))) throw new Error("SECTION is required; live reads also require GRADE_OWNER and WORKSPACE_PREFIX");
const config = existsSync("course.config.json") ? JSON.parse(readFileSync("course.config.json", "utf8")) : {};
const teachers = config.teachers || [];
if (!snapshot && !teachers.length) throw new Error("course.config.json teachers must be configured to verify workspace accounts");
const gh = args => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let records;
if (snapshot) {
  const input = JSON.parse(readFileSync(snapshot, "utf8"));
  records = Array.isArray(input) ? input : input.records;
  if (!Array.isArray(records)) throw new Error("Snapshot must contain an array of records");
} else {
  const names = JSON.parse(gh(["repo", "list", owner, "--limit", "5000", "--json", "name"])).map(repo => repo.name);
  if (names.length >= 5000) throw new Error("Repository listing reached its limit; increase the limit before syncing");
  const escaped = String(section).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const submission = new RegExp(`^(?:m\\d+a\\d+|q\\d+|prelim|midterm)-${escaped}-`, "i");
  records = names.filter(name => name.toLowerCase().startsWith(prefix) || submission.test(name)).map(repo => {
    const record = { repo, workspace: repo.toLowerCase().startsWith(prefix) };
    try { record.student = gh(["api", `repos/${owner}/${repo}/contents/student.json`, "-H", "Accept: application/vnd.github.raw+json"]); }
    catch { record.error = "student-json-read-failed"; }
    try { record.collaborators = gh(["api", "--paginate", `repos/${owner}/${repo}/collaborators?affiliation=direct`, "--jq", ".[].login"]).trim().split(/\n/).filter(Boolean); }
    catch { record.error = "collaborator-read-failed"; }
    return record;
  });
}
const path = "roster/students.json";
const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const canvasPath = arg("canvas") || `roster/${section}.csv`;
const canvasJsonPath = arg("canvas-json");
const canvas = canvasJsonPath ? canvasRosterJson(JSON.parse(readFileSync(canvasJsonPath, "utf8"))) : existsSync(canvasPath) ? canvasRoster(readFileSync(canvasPath, "utf8")) : [];
const reconcile = process.argv.includes("--reconcile");
let canvasBindings = [];
if (reconcile) {
  const bindingPath = arg("canvas-bindings") || "roster/canvas-account-bindings.json";
  const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  const policy = JSON.parse(readFileSync("grader/badges.json", "utf8"));
  const age = Date.now() - new Date(binding.generatedAt).getTime();
  if (binding.schemaVersion !== 1 || String(binding.section) !== String(section) || !/^\d+$/.test(String(binding.canvasCourseId)) || !/^\d+$/.test(String(policy.canvasCourseId)) || String(binding.canvasCourseId) !== String(policy.canvasCourseId) || !Array.isArray(binding.links) || !Number.isFinite(age) || age < 0 || age > 24 * 3600000) throw new Error("Canvas account bindings must match this course and be refreshed within 24 hours");
  canvasBindings = binding.links;
}
const roster = (reconcile ? reconcileStudentRoster : buildStudentRoster)(records, { section, teachers, previous, canvas, canvasBindings });
const execute = process.argv.includes("--execute");
if (execute) {
  mkdirSync("roster", { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(roster, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", reconcile, sources: records.length, students: roster.students.filter(student => !student.superseded).length, verified: roster.students.filter(student => student.identityStatus === "verified" && !student.superseded).length, held: roster.students.filter(student => student.identityStatus === "held" && !student.superseded).length, errors: roster.errors.length, canvasRecords: canvas.length, quarantinedSources: roster.reconciliation?.quarantinedSources.length || 0, supersededRecords: roster.reconciliation?.supersededRecords.length || 0 }));
