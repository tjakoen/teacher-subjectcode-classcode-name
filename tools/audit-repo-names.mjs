#!/usr/bin/env node
// Audit student/teacher repo names against the course's expected naming:
//   <role>-<subjectcode>-<classcode>-<rest>   (all lowercase)
// Catches the mistakes we've actually seen students make when creating repos
// from the template: wrong subjectcode (e.g. `6xxx` copied from an example),
// swapped subject/classcode order, malformed separators (`.` instead of `-`),
// and stray casing.
//
// Reads repo names on stdin - either a JSON array of {name} / strings, or
// newline-delimited names (same input shape as list-section-repos.mjs).
//
// Usage:
//   gh repo list ORG --json name -q '.[].name' \
//     | node audit-repo-names.mjs <subjectcode> <classcode>
//
// Exit code is 1 only for mismatches that can actually lose a delivery, so a red
// run means real work. Pure casing drift is reported as a note and exits 0.
import { readFileSync } from "node:fs";

const subject = (process.argv[2] ?? "").toLowerCase();
const classCode = process.argv[3] ?? "";
if (!subject || !classCode) {
  console.error("usage: audit-repo-names.mjs <subjectcode> <classcode>");
  process.exit(2);
}

const input = readFileSync(0, "utf8").trim();
let names;
try {
  const parsed = JSON.parse(input);
  names = Array.isArray(parsed) ? parsed.map((x) => x.name ?? x) : [];
} catch {
  names = input.split("\n").map((s) => s.trim()).filter(Boolean);
}

// Only role repos are subject to this convention; activity/template repos aren't.
const allRoleRepos = names.filter((n) => /^(student|teacher)-/i.test(n));

// A teacher repo is responsible for its OWN section only. The workflow pipes the
// whole org listing in, so in a multi-section org every sibling section's
// workspaces used to count as failures - 110 of them in one APSI section. That,
// far more than casing, is why this audit was permanently red and therefore
// ignored. Scope to repos naming this classCode, plus repos naming no class code
// at all (those belong to nobody, so someone has to own them).
const claimsAnotherSection = (n) => {
  const found = (n.toLowerCase().match(/-(\d{4})(?=-|$)/g) || []).map((t) => t.slice(1));
  return found.length > 0 && !found.includes(classCode);
};
const roleRepos = allRoleRepos.filter((n) => !claimsAnotherSection(n));
const skipped = allRoleRepos.length - roleRepos.length;

const want = (role) => `${role}-${subject}-${classCode}-`;

function audit(name) {
  const role = name.toLowerCase().startsWith("teacher-") ? "teacher" : "student";
  const expected = want(role);
  if (name.startsWith(expected)) return { ok: true };

  const lower = name.toLowerCase();
  // Right shape, wrong casing somewhere in the fixed prefix.
  if (lower.startsWith(expected)) {
    return { ok: false, reason: `wrong case (should be lowercase \`${expected}…\`)` };
  }
  // Subject + classCode both present but in the wrong order.
  if (lower.includes(`-${classCode}-${subject}-`) || lower.includes(`-${classCode}-${subject}`)) {
    return { ok: false, reason: `subject/classCode swapped (want \`${expected}…\`)` };
  }
  // Correct classCode is present but the subjectcode segment is wrong.
  if (lower.includes(`-${classCode}-`) || lower.includes(`-${classCode}.`)) {
    return { ok: false, reason: `wrong subjectcode (want \`${subject}\`, fix to \`${expected}…\`)` };
  }
  // ClassCode missing/different.
  return { ok: false, reason: `does not match \`${expected}…\` (check subjectcode + classCode)` };
}

// Not every mismatch costs a grade. A workspace that is `student-6XXX-0000-x`
// instead of `student-6xxx-0000-x` resolves fine everywhere (the matchers all
// lowercase), and there are dozens of them, so exiting 1 on those made this
// audit permanently red and therefore ignored. Casing is reported but does not
// fail the run; anything that can actually lose a delivery still does.
const COSMETIC = /^wrong case/;
let blocking = 0, cosmetic = 0;
const lines = [];
for (const name of roleRepos.sort()) {
  const r = audit(name);
  if (r.ok) {
    lines.push(`  ok   ${name}`);
  } else if (COSMETIC.test(r.reason)) {
    cosmetic++;
    lines.push(`  note ${name}  - ${r.reason} (cosmetic, resolves anyway)`);
  } else {
    blocking++;
    lines.push(`  FAIL ${name}  - ${r.reason}`);
  }
}

console.log(`Repo-name audit for ${subject}-${classCode} (${roleRepos.length} role repos in scope, ${skipped} belonging to other sections):`);
console.log(lines.join("\n"));
console.log(`\n${roleRepos.length - blocking - cosmetic} ok, ${blocking} need attention, ${cosmetic} cosmetic.`);
console.log("NOTE: this audit only covers student-/teacher- repos. Misnamed SUBMISSION repos are reported by the grade sweep in gradebook/UNMATCHED.md.");
process.exit(blocking ? 1 : 0);
