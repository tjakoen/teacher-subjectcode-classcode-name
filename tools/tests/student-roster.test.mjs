import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { buildStudentRoster, reconcileStudentRoster, canvasRoster, canvasRosterJson } from "../lib/student-roster.mjs";
const source = (repo, extra = {}) => ({ repo, collaborators: ["learner"], student: { studentNumber: "2026-1234567", classCode: "1000", githubAccount: "learner", studentEmail: "school@example.com", personalEmail: "personal@example.com", pcNumber: "1", room: "A" }, ...extra });
const options = { section: "1000", teachers: ["teacher"] };
test("merges observations and keeps distinct values as arrays", () => {
  const first = source("activity"), second = source("workspace", { workspace: true, collaborators: ["teacher", "learner"] });
  second.student = { ...second.student, pcNumber: ["1", "2"], room: "B" };
  const roster = buildStudentRoster([first, second], options);
  assert.equal(roster.students.length, 1);
  assert.deepEqual(roster.students[0].fields.pcNumber, ["1", "2"]);
  assert.deepEqual(roster.students[0].fields.room, ["A", "B"]);
  assert.equal(roster.students[0].identityStatus, "verified");
  assert.equal(roster.students[0].verifiedGithubAccount, "learner");
  assert.equal(roster.students[0].sources.length, 2);
});
test("warns about stale declared accounts while direct ownership remains authoritative", () => {
  const roster = buildStudentRoster([source("workspace", { workspace: true, collaborators: ["other"] })], options);
  assert.equal(roster.students[0].identityStatus, "verified");
  assert.ok(roster.students[0].warnings.includes("declared-account-conflict"));
  assert.equal(buildStudentRoster([source("workspace", { workspace: true, collaborators: ["learner", "other"] })], options).students[0].verifiedGithubAccount, null);
});
test("holds shared accounts, unknown identities, and unavailable access", () => {
  const a = source("one", { workspace: true, collaborators: ["learner"] });
  const b = source("two", { workspace: true, collaborators: ["learner"] }); b.student.studentNumber = "7654321";
  assert.ok(buildStudentRoster([a, b], options).students.every(row => row.holds.includes("account-shared-across-identities")));
  assert.ok(buildStudentRoster([a, b], options).students.every(row => row.holds.includes("email-shared-across-identities")));
  a.student.studentNumber = ""; delete a.collaborators;
  const row = buildStudentRoster([a], options).students[0];
  assert.ok(row.holds.includes("missing-or-conflicting-student-number"));
  assert.ok(row.holds.includes("workspace-access-unavailable"));
  a.student.studentNumber = ["1234567", "7654321"];
  assert.ok(buildStudentRoster([a], options).students[0].holds.includes("missing-or-conflicting-student-number"));
});
test("preserves badge delivery records and reports vanished records", () => {
  const records = [source("workspace", { workspace: true, collaborators: ["learner"] })];
  const previous = buildStudentRoster(records, options);
  previous.students[0].badges = [{ url: "https://example.test/badge", delivery: { email: "sent" } }];
  assert.deepEqual(buildStudentRoster(records, { ...options, previous }).students[0].badges, previous.students[0].badges);
  const missing = buildStudentRoster([], { ...options, previous });
  assert.equal(missing.students[0].stale, true);
  assert.equal(missing.errors[0].code, "previous-record-retained");
});
test("reports invalid JSON and refuses incompatible prior schema", () => {
  assert.equal(buildStudentRoster([{ repo: "bad", student: "{" }], options).errors[0].code, "invalid-student-json");
  assert.throws(() => buildStudentRoster([], { ...options, previous: { schemaVersion: 2 } }));
});
test("joins Canvas on number or school email and holds ambiguous matches", () => {
  const canvas = canvasRoster('Student,ID,SIS User ID,SIS Login ID,Section\nExample,1,1234567,school@example.com,1000\n');
  const records = [source("workspace", { workspace: true, collaborators: ["learner"] })];
  assert.deepEqual(buildStudentRoster(records, { ...options, canvas }).students[0].canvasIds, ["1"]);
  assert.ok(buildStudentRoster(records, { ...options, canvas: [...canvas, { id: "2", studentNumber: "1234567", email: "" }] }).students[0].holds.includes("canvas-identity-conflict"));
});
test("holds an unowned submission that injects a contact into another identity", () => {
  const workspace = source("workspace", { workspace: true, collaborators: ["learner"] });
  const injected = source("submission", { collaborators: ["attacker"] });
  injected.student = { ...injected.student, githubAccount: "", personalEmail: "attacker@example.com" };
  const row = buildStudentRoster([workspace, injected], options).students[0];
  assert.equal(row.identityStatus, "held");
  assert.ok(row.holds.includes("source-account-conflict"));
  assert.ok(row.fields.personalEmail.includes("attacker@example.com"));
  delete injected.collaborators;
  assert.ok(buildStudentRoster([workspace, injected], options).students[0].holds.includes("source-access-unavailable"));
});
test("reads Canvas headers after comments and rejects invalid or empty exports", () => {
  assert.equal(canvasRoster('# export\nStudent,ID,SIS User ID,SIS Login ID\nPoints Possible,,,,\nExample,1,1234567,school@example.com\n').length, 1);
  assert.throws(() => canvasRoster("Student,Other\n"));
  assert.throws(() => canvasRoster("Student,ID,SIS User ID,SIS Login ID\nPoints Possible,,,,\n"));
  assert.throws(() => canvasRosterJson([{ studentNumber: "1234567", email: "school@example.com" }]));
  assert.deepEqual(canvasRosterJson([{ id: 1, studentNumber: "1234567", login: "school@example.com" }]), [{ id: "1", studentNumber: "1234567", email: "school@example.com", login: "school@example.com", name: "" }]);
});
test("uses authoritative Canvas names and retains all observed names", () => {
  const first = source("workspace", { workspace: true }); first.student.fullName = "Observed Name";
  const second = source("submission"); second.student.fullName = "Different Name";
  const canvas = [{ id: "1", studentNumber: "1234567", email: "school@example.com", name: "  Canvas Name  " }];
  const row = buildStudentRoster([first, second], { ...options, canvas }).students[0];
  assert.equal(row.canonicalName, "Canvas Name");
  assert.deepEqual(row.fields.fullName, ["Different Name", "Observed Name"]);
  assert.equal(buildStudentRoster([first, second], options).students[0].canonicalName, null);
  second.student.fullName = "observed name";
  assert.ok(buildStudentRoster([first, second], options).students[0].canonicalName);
  first.student.githubAccount = "stale-alias";
  second.collaborators = ["attacker"];
  const held = buildStudentRoster([first, second], options).students[0];
  assert.ok(held.warnings.includes("declared-account-conflict"));
  assert.ok(held.holds.includes("source-account-conflict"));
});
const authoritativeCanvas = [{ id: "1", studentNumber: "1234567", email: "school@example.com", name: "Canvas Name" }];
const reconcileOptions = { ...options, canvas: authoritativeCanvas, canvasBindings: [{ account: "learner", canvasUserId: "1", repo: "workspace", assignmentId: "10", activityId: "m1a1" }, { account: "learner", canvasUserId: "1", repo: "workspace", assignmentId: "11", activityId: "m1a2" }] };
test("reconciliation canonicalizes owned aliases without losing observations", () => {
  const workspace = source("workspace", { workspace: true });
  const alias = source("alias"); alias.student = { ...alias.student, studentNumber: "0000000", classCode: "9999", personalEmail: "untrusted@example.com" };
  const row = reconcileStudentRoster([workspace, alias], reconcileOptions).students[0];
  assert.equal(row.identityStatus, "verified");
  assert.deepEqual(row.fields.studentNumber, ["1234567"]);
  assert.deepEqual(row.fields.classCode, ["1000"]);
  assert.deepEqual(row.fields.personalEmail, ["personal@example.com"]);
  assert.deepEqual(row.observedFields.studentNumber, ["0000000", "1234567"]);
  assert.equal(row.sources.find(s => s.repo === "alias").observedStudent.studentNumber, "0000000");
});
test("reconciliation accepts email-only anchors but quarantines foreign claims", () => {
  const workspace = source("workspace", { workspace: true }); workspace.student.studentNumber = "";
  const alias = source("alias"); alias.student.studentNumber = "7654321";
  const canvas = [...authoritativeCanvas, { id: "2", studentNumber: "7654321", email: "other@example.com", name: "Other" }];
  const roster = reconcileStudentRoster([workspace, alias], { ...reconcileOptions, canvas });
  assert.equal(roster.reconciliation.anchoredSources, 1);
  assert.equal(roster.reconciliation.quarantinedSources[0].code, "source-claims-another-canvas-identity");
  assert.equal(roster.students.find(s => !s.quarantined).identityStatus, "verified");
});
test("reconciliation needs links from two distinct assignments before a Canvas submission corroborates an account", () => {
  const workspace = source("workspace", { workspace: true });
  const one = { account: "learner", canvasUserId: "1", repo: "workspace", assignmentId: "10", activityId: "m1a1" };
  const anchored = canvasBindings => reconcileStudentRoster([workspace], { ...reconcileOptions, canvasBindings }).reconciliation.anchoredSources;
  assert.equal(anchored([one]), 0);
  assert.equal(anchored([one, { ...one }]), 0);
  assert.equal(anchored([one, { ...one, assignmentId: "11" }]), 0);
  assert.equal(anchored([one, { ...one, assignmentId: "11", activityId: "m1a2" }]), 1);
  assert.equal(anchored([{ ...one, activityId: undefined }, { ...one, assignmentId: "11", activityId: undefined }]), 1);
});
test("a classmate linking the workspace once does not displace the owner linking twice", () => {
  const workspace = source("workspace", { workspace: true });
  const own = [{ account: "learner", canvasUserId: "1", repo: "workspace", assignmentId: "10", activityId: "m1a1" }, { account: "learner", canvasUserId: "1", repo: "workspace", assignmentId: "11", activityId: "m1a2" }];
  const stray = { account: "learner", canvasUserId: "2", repo: "workspace", assignmentId: "10", activityId: "m1a1" };
  assert.equal(reconcileStudentRoster([workspace], { ...reconcileOptions, canvasBindings: [...own, stray] }).reconciliation.anchoredSources, 1);
  const both = [...own, stray, { ...stray, assignmentId: "11", activityId: "m1a2" }];
  assert.equal(reconcileStudentRoster([workspace], { ...reconcileOptions, canvasBindings: both }).reconciliation.anchoredSources, 0);
});
test("reconciliation excludes ownerless contact injections", () => {
  const workspace = source("workspace", { workspace: true });
  const injection = source("injection", { collaborators: [] }); injection.student.personalEmail = "attacker@example.com";
  const roster = reconcileStudentRoster([workspace, injection], reconcileOptions);
  assert.deepEqual(roster.students.find(s => !s.quarantined).fields.personalEmail, ["personal@example.com"]);
  assert.equal(roster.reconciliation.quarantinedSources.length, 1);
  assert.equal(roster.students.find(s => s.quarantined).identityStatus, "held");
});
test("reconciliation rejects workspace disagreement and multiple Canvas owners", () => {
  const a = source("workspace-a", { workspace: true }), b = source("workspace-b", { workspace: true, collaborators: ["other"] });
  assert.equal(reconcileStudentRoster([a, b], reconcileOptions).reconciliation.anchoredSources, 0);
  a.student.studentEmail = "other@example.com";
  const canvas = [...authoritativeCanvas, { id: "2", studentNumber: "7654321", email: "other@example.com" }];
  assert.equal(reconcileStudentRoster([a], { ...options, canvas }).reconciliation.anchoredSources, 0);
  assert.throws(() => reconcileStudentRoster([a], options));
});
test("reconciliation preserves badges and superseded aliases while holding contradictions", () => {
  const workspace = source("workspace", { workspace: true }), alias = source("alias"); alias.student.studentNumber = "0000000";
  const records = [workspace, alias], previous = buildStudentRoster(records, options);
  const badge = { awardKey: "award", badgeId: "legacy-prelim", certId: "cert", url: "https://example.test/cert", issuedOn: "2026-01-01", delivery: { email: "sent" } };
  for (const row of previous.students) row.badges = [structuredClone(badge)];
  const roster = reconcileStudentRoster(records, { ...reconcileOptions, previous });
  const canonical = roster.students.find(s => !s.superseded && !s.unresolvedPrior);
  assert.deepEqual(canonical.badges, [badge]);
  assert.equal(roster.students.filter(s => s.superseded).length, 1);
  assert.ok(roster.reconciliation.inputDigest);
  previous.students[1].badges[0].certId = "different";
  const conflicted = reconcileStudentRoster(records, { ...reconcileOptions, previous });
  assert.ok(conflicted.students.some(s => s.holds.includes("prior-award-conflict")));
  assert.ok(conflicted.students.some(s => s.unresolvedPrior && s.badges[0].certId === "different"));
});
test("reconciliation preserves distinct awards sharing a badge class and stays stable on repeat", () => {
  const workspace = source("workspace", { workspace: true }), alias = source("alias"); alias.student.studentNumber = "0000000";
  const records = [workspace, alias], previous = buildStudentRoster(records, options);
  previous.students[0].badges = [{ awardKey: "one", badgeId: "legacy-prelim", certId: "one", url: "https://example.test/one", issuedOn: "2026-01-01", delivery: { email: "sent" } }];
  previous.students[1].badges = [{ awardKey: "two", badgeId: "legacy-prelim", certId: "two", url: "https://example.test/two", issuedOn: "2026-01-01", delivery: { email: "pending" } }];
  const first = reconcileStudentRoster(records, { ...reconcileOptions, previous });
  const second = reconcileStudentRoster(records, { ...reconcileOptions, previous: first });
  assert.equal(second.students.find(s => !s.superseded && !s.unresolvedPrior).badges.length, 2);
  assert.deepEqual(second.students.find(s => !s.superseded && !s.unresolvedPrior).badges, first.students.find(s => !s.superseded && !s.unresolvedPrior).badges);
});

test("reconciliation requires independent Canvas account binding", () => {
  const workspace = source("workspace", { workspace: true });
  assert.equal(reconcileStudentRoster([workspace], { ...reconcileOptions, canvasBindings: [] }).reconciliation.anchoredSources, 0);
  const copied = { ...reconcileOptions, canvasBindings: [{ account: "learner", canvasUserId: "2", repo: "workspace", assignmentId: "10" }] };
  assert.equal(reconcileStudentRoster([workspace], copied).reconciliation.anchoredSources, 0);
  const injected = { ...reconcileOptions, canvasBindings: [{ account: "learner", canvasUserId: "1", repo: "foreign-unowned-repo", assignmentId: "10" }] };
  assert.equal(reconcileStudentRoster([workspace], injected).reconciliation.anchoredSources, 0);
});

test("an identity-free workspace stays quarantined without replacing the corroborated workspace", () => {
  const workspace = source("workspace", { workspace: true });
  const empty = source("empty-workspace", { workspace: true, student: null });
  const roster = reconcileStudentRoster([workspace, empty], reconcileOptions);
  const canonical = roster.students.find(row => row.identityStatus === "verified");
  assert.deepEqual(canonical.workspaceRepos, ["workspace"]);
  assert.equal(roster.excludedSources[0].repo, "empty-workspace");
  assert.equal(roster.excludedSources[0].code, "invalid-student-json");
});

test("previous quarantine flags cannot hide a newly corroborated canonical identity", () => {
  const records = [source("workspace", { workspace: true })];
  const held = reconcileStudentRoster(records, { ...reconcileOptions, canvasBindings: [] });
  const cleared = reconcileStudentRoster(records, { ...reconcileOptions, previous: held });
  const canonical = cleared.students.find(row => row.identityStatus === "verified");
  assert.ok(canonical);
  assert.equal(canonical.quarantined, undefined);
  assert.equal(canonical.superseded, undefined);
});

test("reconciliation evidence records the bound account and workspace", () => {
  const row = reconcileStudentRoster([source("workspace", { workspace: true })], reconcileOptions).students.find(s => s.identityStatus === "verified");
  assert.equal(row.identityEvidence.githubAccount, "learner");
  assert.equal(row.identityEvidence.workspaceRepo, "workspace");
});

test("a plain sync drops identity evidence once the workspace account changes", () => {
  const records = [source("workspace", { workspace: true })], alias = source("alias"); alias.student.studentNumber = "0000000";
  const reconciled = reconcileStudentRoster([...records, alias], reconcileOptions);
  const badge = { awardKey: "award", url: "https://example.test/cert" };
  reconciled.students.find(s => s.identityStatus === "verified").badges = [badge];
  const key = reconciled.students.find(s => s.identityStatus === "verified").studentKey, pick = roster => roster.students.find(s => s.studentKey === key);
  const same = pick(buildStudentRoster([...records, alias], { ...options, previous: reconciled }));
  assert.equal(same.identityEvidence.githubAccount, "learner");
  const moved = pick(buildStudentRoster([source("workspace", { workspace: true, collaborators: ["someone-else"] }), alias], { ...options, previous: reconciled }));
  assert.equal(moved.identityEvidence, undefined);
  assert.ok(moved.holds.includes("identity-evidence-binding-changed"));
  assert.equal(moved.identityStatus, "held");
  assert.deepEqual(moved.badges, [badge]);
  assert.ok(moved.observedFields.studentNumber.includes("0000000"));
  assert.ok(moved.sources.length >= 1);
  const relocated = pick(buildStudentRoster([source("new-workspace", { workspace: true }), alias], { ...options, previous: reconciled }));
  assert.equal(relocated.identityEvidence, undefined);
  assert.ok(relocated.holds.includes("identity-evidence-binding-changed"));
});

test("reconcile refuses bindings and policy that both lack a numeric Canvas course id", () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-sync-"));
  try {
    mkdirSync(join(dir, "grader")); mkdirSync(join(dir, "roster"));
    writeFileSync(join(dir, "grader/badges.json"), JSON.stringify({ badges: [] }));
    writeFileSync(join(dir, "roster/canvas-account-bindings.json"), JSON.stringify({ schemaVersion: 1, section: "1000", generatedAt: new Date().toISOString(), links: [] }));
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify([source("workspace", { workspace: true })]));
    writeFileSync(join(dir, "canvas.json"), JSON.stringify([{ id: 1, studentNumber: "1234567", email: "school@example.com" }]));
    const script = fileURLToPath(new URL("../sync-student-roster.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script, "--from-snapshot=snapshot.json", "--canvas-json=canvas.json", "--reconcile"], { cwd: dir, env: { ...process.env, SECTION: "1000" }, encoding: "utf8" });
    assert.match(run().stderr, /Canvas account bindings must match this course/);
    writeFileSync(join(dir, "grader/badges.json"), JSON.stringify({ canvasCourseId: 55, badges: [] }));
    writeFileSync(join(dir, "roster/canvas-account-bindings.json"), JSON.stringify({ schemaVersion: 1, section: "1000", canvasCourseId: 55, generatedAt: new Date().toISOString(), links: [] }));
    assert.equal(run().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
