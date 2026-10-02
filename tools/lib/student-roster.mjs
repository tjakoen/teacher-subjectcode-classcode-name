import { createHash } from "node:crypto";
import { parseCsv, normNum, normEmail, normGh } from "./gradebook.mjs";

export const ROSTER_FIELDS = ["classCode", "fullName", "studentNumber", "studentEmail", "personalEmail", "githubAccount", "pcNumber", "room"];
const unique = values => [...new Set(values)].sort();
const hash = value => createHash("sha256").update(value).digest("hex");
const valuesOf = (field, value) => unique((Array.isArray(value) ? value : [value]).filter(v => typeof v === "string" || typeof v === "number").map(v => {
  if (field === "studentNumber") return normNum(v);
  if (/Email$/.test(field)) return normEmail(v);
  if (field === "githubAccount") return normGh(v);
  return String(v).trim();
}).filter(Boolean));
const validNumber = value => /^\d{6,9}$/.test(value);

export function canvasRoster(text) {
  const parsed = parseCsv(text);
  const headerIndex = parsed.findIndex(row => row.includes("Student") && row.includes("ID") && row.includes("SIS User ID") && row.includes("SIS Login ID"));
  if (headerIndex < 0) throw new Error("Canvas CSV is missing required identity columns");
  const headers = parsed[headerIndex], rows = parsed.slice(headerIndex + 1);
  const index = name => headers.indexOf(name);
  const result = rows.filter(row => /^\d+$/.test(row[index("ID")] || "") && !/^\s*(?:#|points possible)/i.test(row[index("Student")] || "")).map(row => ({
    id: row[index("ID")], studentNumber: normNum(row[index("SIS User ID")]), email: normEmail(row[index("SIS Login ID")]), name: String(row[index("Student")] || "").trim(),
  }));
  if (!result.length) throw new Error("Canvas CSV contains no student records");
  return result;
}

export function canvasRosterJson(input) {
  if (!Array.isArray(input) || !input.length) throw new Error("Canvas JSON must contain student records");
  return input.map(row => {
    if (!/^\d+$/.test(String(row.id || ""))) throw new Error("Canvas JSON record is missing its numeric Canvas ID");
    return { id: String(row.id), studentNumber: normNum(row.studentNumber || row.sis_user_id), email: normEmail(row.email || row.login || row.login_id), ...(row.login || row.login_id ? { login: normEmail(row.login || row.login_id) } : {}), name: String(row.name || "").trim() };
  });
}

export function buildStudentRoster(records, { section, teachers = [], previous = null, canvas = [], generatedAt = new Date().toISOString() } = {}) {
  if (!section) throw new Error("section is required");
  if (previous && (previous.schemaVersion !== 1 || String(previous.section) !== String(section) || !Array.isArray(previous.students))) throw new Error("Previous roster schema or section does not match");
  const errors = [], groups = new Map(), teacherSet = new Set(teachers.map(normGh));
  for (const record of records) {
    const repo = String(record.repo || "");
    let student = record.student;
    try { if (typeof student === "string") student = JSON.parse(student); } catch { errors.push({ repo, code: "invalid-student-json" }); continue; }
    if (!student || typeof student !== "object" || Array.isArray(student)) { errors.push({ repo, code: "missing-student-json" }); continue; }
    const fields = Object.fromEntries(ROSTER_FIELDS.map(field => [field, valuesOf(field, student[field])]));
    const nums = fields.studentNumber.filter(validNumber);
    const number = nums.length === 1 && fields.studentNumber.length === 1 ? nums[0] : null;
    const studentKey = hash(number ? `${section}|${number}` : `${section}|unresolved|${repo}`);
    if (!groups.has(studentKey)) groups.set(studentKey, { studentKey, fields: Object.fromEntries(ROSTER_FIELDS.map(field => [field, []])), canonicalName: null, verifiedGithubAccount: null, workspaceRepos: [], sources: [], canvasIds: [], identityStatus: "held", holds: [], warnings: [], badges: [] });
    const row = groups.get(studentKey);
    for (const field of ROSTER_FIELDS) row.fields[field] = unique([...row.fields[field], ...fields[field]]);
    const collaboratorsRead = Array.isArray(record.collaborators);
    const collaborators = unique((record.collaborators || []).map(normGh).filter(login => login && !teacherSet.has(login)));
    row.sources.push({ repo, workspace: !!record.workspace, fields, collaborators, collaboratorsRead });
    if (record.workspace) row.workspaceRepos.push(repo);
    if (!number) row.holds.push("missing-or-conflicting-student-number");
    if (fields.classCode.some(code => code !== String(section))) row.holds.push("section-conflict");
    if (record.error) errors.push({ repo, code: record.error });
  }
  const accountOwners = new Map(), emailOwners = new Map(), canvasOwners = new Map();
  for (const row of groups.values()) {
    row.workspaceRepos = unique(row.workspaceRepos);
    const workspaces = row.sources.filter(source => source.workspace);
    const accounts = unique(workspaces.flatMap(source => source.collaborators));
    if (!workspaces.length) row.holds.push("no-workspace");
    if (workspaces.some(source => !source.collaboratorsRead)) row.holds.push("workspace-access-unavailable");
    if (workspaces.some(source => source.collaborators.length !== 1) || accounts.length !== 1) row.holds.push("workspace-account-conflict");
    if (accounts.length === 1 && workspaces.every(source => source.collaboratorsRead && source.collaborators.length === 1)) {
      row.verifiedGithubAccount = accounts[0];
      if (!accountOwners.has(accounts[0])) accountOwners.set(accounts[0], []);
      accountOwners.get(accounts[0]).push(row);
      if (row.fields.githubAccount.some(account => account !== accounts[0])) row.warnings.push("declared-account-conflict");
    }
    if (row.sources.some(source => !source.collaboratorsRead)) row.holds.push("source-access-unavailable");
    if (row.sources.some(source => source.collaboratorsRead && (source.collaborators.length !== 1 || source.collaborators[0] !== row.verifiedGithubAccount))) row.holds.push("source-account-conflict");
    const matches = canvas.filter(person => row.fields.studentNumber.includes(person.studentNumber) || row.fields.studentEmail.includes(person.email));
    row.canvasIds = unique(matches.map(person => String(person.id)));
    const observedNames = new Map();
    for (const name of row.fields.fullName) observedNames.set(name.toLowerCase().replace(/\s+/g, " "), name);
    if (matches.length === 1 && String(matches[0].name || "").trim()) row.canonicalName = String(matches[0].name).trim();
    else if (!matches.length && observedNames.size === 1) row.canonicalName = [...observedNames.values()][0];
    if (row.canvasIds.length > 1) row.holds.push("canvas-identity-conflict");
    if (canvas.length && row.canvasIds.length === 0) row.holds.push("canvas-identity-unmatched");
    for (const email of unique([...row.fields.studentEmail, ...row.fields.personalEmail])) {
      if (!emailOwners.has(email)) emailOwners.set(email, []);
      emailOwners.get(email).push(row);
    }
    for (const id of row.canvasIds) {
      if (!canvasOwners.has(id)) canvasOwners.set(id, []);
      canvasOwners.get(id).push(row);
    }
  }
  for (const owners of accountOwners.values()) if (owners.length > 1) for (const row of owners) row.holds.push("account-shared-across-identities");
  for (const owners of emailOwners.values()) if (owners.length > 1) for (const row of owners) row.holds.push("email-shared-across-identities");
  for (const owners of canvasOwners.values()) if (owners.length > 1) for (const row of owners) row.holds.push("canvas-student-shared-across-identities");
  for (const prior of previous?.students || []) {
    const row = groups.get(prior.studentKey);
    if (row) {
      // Award records and their delivery state belong to the issuer, not this derived index.
      row.badges = prior.badges || [];
      // Evidence proves one account and one workspace; it cannot follow a row whose binding has moved.
      const evidence = prior.identityEvidence, bound = evidence && evidence.githubAccount !== undefined && evidence.workspaceRepo !== undefined;
      const rebound = bound && (normGh(evidence.githubAccount) !== row.verifiedGithubAccount || row.workspaceRepos.length !== 1 || String(evidence.workspaceRepo).toLowerCase() !== row.workspaceRepos[0].toLowerCase());
      if (rebound) row.holds.push("identity-evidence-binding-changed");
      for (const [key, value] of Object.entries(prior)) if (!(key in row) && key !== "stale" && !(rebound && key === "identityEvidence")) row[key] = value;
    } else {
      groups.set(prior.studentKey, { ...prior, stale: true, identityStatus: "held", holds: unique([...(prior.holds || []), "source-record-no-longer-observed"]) });
      errors.push({ studentKey: prior.studentKey, code: "previous-record-retained" });
    }
  }
  for (const row of groups.values()) { row.holds = unique(row.holds); row.warnings = unique(row.warnings || []); row.identityStatus = row.holds.length ? "held" : "verified"; }
  return { schemaVersion: 1, section: String(section), generatedAt, students: [...groups.values()].sort((a, b) => a.studentKey.localeCompare(b.studentKey)), errors };
}

// Reconciliation changes the private derived index, never the student-owned observations.
export function reconcileStudentRoster(records, options = {}) {
  const { section, teachers = [], canvas = [], canvasBindings = [], previous = null, generatedAt = new Date().toISOString() } = options;
  if (!canvas.length) throw new Error("Reconciliation requires a current Canvas roster");
  if (previous && (previous.schemaVersion !== 1 || String(previous.section) !== String(section) || !Array.isArray(previous.students))) throw new Error("Previous roster schema or section does not match");
  const teacherSet = new Set(teachers.map(normGh));
  const parsed = records.map(record => {
    let student = record.student;
    try { if (typeof student === "string") student = JSON.parse(student); } catch { student = null; }
    const observedFields = Object.fromEntries(ROSTER_FIELDS.map(field => [field, valuesOf(field, student?.[field])]));
    const collaborators = Array.isArray(record.collaborators) ? unique(record.collaborators.map(normGh).filter(account => account && !teacherSet.has(account))) : null;
    return { ...record, student, observedFields, collaborators, account: collaborators?.length === 1 ? collaborators[0] : null };
  });
  const matches = record => canvas.filter(person => record.observedFields.studentNumber.includes(normNum(person.studentNumber)) || [person.email, person.login].filter(Boolean).some(email => record.observedFields.studentEmail.includes(normEmail(email))));
  const candidates = new Map(), reasons = new Map();
  for (const record of parsed.filter(record => record.workspace && record.account)) {
    // An identity-free duplicate workspace remains quarantined; it cannot contradict an independently corroborated anchor.
    if (!record.student || typeof record.student !== "object" || Array.isArray(record.student)) continue;
    const identities = matches(record);
    if (identities.length !== 1 || !validNumber(normNum(identities[0]?.studentNumber))) { reasons.set(record.account, "workspace-canvas-identity-unresolved"); continue; }
    if (!candidates.has(record.account)) candidates.set(record.account, []);
    candidates.get(record.account).push({ workspace: record, person: identities[0] });
  }
  const anchors = new Map(), canvasOwners = new Map();
  for (const [account, entries] of candidates) {
    if (entries.length !== 1 || reasons.has(account)) { reasons.set(account, "multiple-or-conflicting-workspace-anchors"); continue; }
    const ownedRepos = new Set(parsed.filter(record => record.account === account).map(record => record.repo));
    // One submitted link is not corroboration: a classmate's repository can be pasted into a single assignment.
    // Each Canvas identity needs links from at least two distinct assignments (and distinct activities where those resolve).
    const linked = canvasBindings.filter(binding => normGh(binding.account) === account && ownedRepos.has(binding.repo) && /^\d+$/.test(String(binding.canvasUserId)) && binding.assignmentId !== undefined && binding.assignmentId !== null);
    const supported = new Set(unique(linked.map(binding => String(binding.canvasUserId))).filter(id => {
      const own = linked.filter(binding => String(binding.canvasUserId) === id);
      return new Set(own.map(binding => String(binding.assignmentId))).size >= 2 && new Set(own.map(binding => binding.activityId ? String(binding.activityId).toLowerCase() : `assignment:${binding.assignmentId}`)).size >= 2;
    }));
    const submitted = linked.filter(binding => supported.has(String(binding.canvasUserId)));
    const submittedIdentities = unique(submitted.map(binding => String(binding.canvasUserId)));
    if (submittedIdentities.length !== 1 || submittedIdentities[0] !== String(entries[0].person.id)) {
      reasons.set(account, submittedIdentities.length ? "canvas-submission-account-conflict" : "canvas-submission-account-unverified"); continue;
    }
    anchors.set(account, { ...entries[0], submitted });
    const id = String(entries[0].person.id);
    if (!canvasOwners.has(id)) canvasOwners.set(id, []);
    canvasOwners.get(id).push(account);
  }
  for (const accounts of canvasOwners.values()) if (accounts.length > 1) for (const account of accounts) { anchors.delete(account); reasons.set(account, "canvas-identity-owned-by-multiple-accounts"); }
  const accepted = [], quarantined = [], keyForRepo = new Map();
  for (const record of parsed) {
    let code = !record.student || typeof record.student !== "object" || Array.isArray(record.student) ? "invalid-student-json" : !record.collaborators ? "source-access-unavailable" : !record.account ? "source-ownership-unresolved" : !anchors.has(record.account) ? reasons.get(record.account) || "no-authoritative-workspace-anchor" : null;
    const anchor = anchors.get(record.account);
    if (!code && matches(record).some(person => String(person.id) !== String(anchor.person.id))) code = "source-claims-another-canvas-identity";
    if (code) { quarantined.push({ record, code }); continue; }
    const person = anchor.person;
    const canonical = { ...record.student, classCode: String(section), studentNumber: normNum(person.studentNumber), fullName: String(person.name || "").trim(), studentEmail: normEmail(person.email || person.login), githubAccount: record.account, personalEmail: record.workspace ? record.observedFields.personalEmail : [] };
    accepted.push({ ...record, student: canonical });
    keyForRepo.set(record.repo, hash(`${section}|${canonical.studentNumber}`));
  }
  const result = buildStudentRoster(accepted, { section, teachers, canvas, generatedAt });
  for (const row of result.students) {
    const anchor = anchors.get(row.verifiedGithubAccount);
    row.identityEvidence = { source: "individual-canvas-submission", canvasUserId: String(anchor.person.id), githubAccount: row.verifiedGithubAccount, workspaceRepo: anchor.workspace.repo,
      submittedRepositories: unique(anchor.submitted.map(binding => binding.repo)), assignmentIds: unique(anchor.submitted.map(binding => String(binding.assignmentId))) };
    row.observedFields = Object.fromEntries(ROSTER_FIELDS.map(field => [field, []]));
    for (const source of row.sources) {
      const observation = parsed.find(record => record.repo === source.repo);
      source.observedFields = observation.observedFields;
      source.observedStudent = observation.student;
      for (const field of ROSTER_FIELDS) row.observedFields[field] = unique([...row.observedFields[field], ...observation.observedFields[field]]);
    }
    if (row.observedFields.githubAccount.some(account => account !== row.verifiedGithubAccount)) row.warnings.push("declared-account-conflict");
    row.warnings = unique(row.warnings);
  }
  const active = new Map(result.students.map(row => [row.studentKey, row]));
  const supersededRecords = [], unresolvedPriorRecords = [];
  const badgeLinks = badge => [badge.url, badge.certificateUrl, badge.assertionUrl, badge.certSlug && `cert:${badge.certSlug}`].filter(Boolean);
  const linkOwners = new Map();
  for (const prior of previous?.students || []) for (const badge of prior.badges || []) for (const link of badgeLinks(badge)) {
    const owned = (prior.sources || []).filter(source => source.collaboratorsRead && source.collaborators?.length === 1);
    const keys = unique(owned.map(source => keyForRepo.get(source.repo)).filter(Boolean));
    const target = keys.length === 1 ? keys[0] : prior.studentKey;
    if (!linkOwners.has(link)) linkOwners.set(link, new Set());
    linkOwners.get(link).add(target);
  }
  for (const prior of previous?.students || []) {
    const owned = (prior.sources || []).filter(source => source.collaboratorsRead && source.collaborators?.length === 1);
    const mapped = owned.map(source => keyForRepo.get(source.repo));
    const keys = unique(mapped.filter(Boolean));
    let target = owned.length && mapped.every(Boolean) && keys.length === 1 && (!(prior.badges || []).length || owned.length === (prior.sources || []).length) ? active.get(keys[0]) : null;
    if (prior.verifiedGithubAccount && target && normGh(prior.verifiedGithubAccount) !== target.verifiedGithubAccount) target = null;
    let unsafe = false;
    if (target) for (const badge of prior.badges || []) {
      const recipient = badge.recipientGithubAccount || badge.githubAccount || badge.recipient?.githubAccount;
      const identity = badge.awardKey || badge.certSlug || badge.url;
      if (recipient && normGh(recipient) !== target.verifiedGithubAccount) unsafe = true;
      if (badgeLinks(badge).some(link => linkOwners.get(link)?.size > 1)) unsafe = true;
      if (identity && target.badges.some(existing => (existing.awardKey || existing.certSlug || existing.url) === identity && ["url", "certId", "issuedOn"].some(field => existing[field] !== badge[field]))) unsafe = true;
    }
    if (!target || unsafe) {
      if (unsafe && target) { target.holds = unique([...target.holds, "prior-award-conflict"]); target.identityStatus = "held"; }
      const retained = { ...prior, studentKey: active.has(prior.studentKey) ? hash(`${section}|unresolved-prior|${prior.studentKey}`) : prior.studentKey, identityStatus: "held", holds: unique([...(prior.holds || []), unsafe ? "prior-award-conflict" : "prior-identity-unresolved"]), unresolvedPrior: true };
      result.students.push(retained); unresolvedPriorRecords.push(prior.studentKey); continue;
    }
    for (const badge of prior.badges || []) {
      const identity = badge.awardKey || badge.certSlug || badge.url;
      const existing = target.badges.find(item => identity && (item.awardKey || item.certSlug || item.url) === identity);
      if (!existing) target.badges.push(structuredClone(badge));
      else if (JSON.stringify(existing) !== JSON.stringify(badge) && !(existing.reconciliationVariants || []).some(variant => JSON.stringify(variant) === JSON.stringify(badge))) {
        existing.reconciliationVariants = [...(existing.reconciliationVariants || []), structuredClone(badge)];
      }
    }
    for (const [key, value] of Object.entries(prior)) if (!(key in target) && !["stale", "superseded", "supersededBy", "unresolvedPrior", "quarantined"].includes(key)) target[key] = value;
    if (prior.studentKey !== target.studentKey) {
      result.students.push({ ...prior, superseded: true, supersededBy: target.studentKey, identityStatus: "held", holds: unique([...(prior.holds || []), "superseded-by-canonical-identity"]) });
      supersededRecords.push(prior.studentKey);
    }
  }
  for (const { record, code } of quarantined) {
    const studentKey = hash(`${section}|quarantined-source|${record.repo}`);
    if (result.students.some(row => row.studentKey === studentKey)) continue;
    result.students.push({ studentKey, fields: record.observedFields, observedFields: record.observedFields, canonicalName: null, verifiedGithubAccount: null, workspaceRepos: record.workspace ? [record.repo] : [], sources: [{ repo: record.repo, workspace: !!record.workspace, fields: record.observedFields, observedFields: record.observedFields, observedStudent: record.student, collaborators: record.collaborators || [], collaboratorsRead: !!record.collaborators }], canvasIds: [], identityStatus: "held", holds: [code], warnings: [], badges: [], quarantined: true });
  }
  result.reconciliation = { mode: "workspace-canvas-anchor", inputDigest: hash(JSON.stringify({ section, records, canvas, canvasBindings })), anchoredSources: accepted.length, quarantinedSources: quarantined.map(({ record, code }) => ({ repo: record.repo, code })), supersededRecords, unresolvedPriorRecords };
  result.excludedSources = quarantined.map(({ record, code }) => ({ repo: record.repo, code, workspace: !!record.workspace, observedStudent: record.student, observedFields: record.observedFields, collaborators: record.collaborators || [], collaboratorsRead: !!record.collaborators, ...(record.error ? { sourceError: record.error } : {}) }));
  result.students.sort((a, b) => a.studentKey.localeCompare(b.studentKey));
  return result;
}
