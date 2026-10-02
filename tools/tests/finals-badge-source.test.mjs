import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { selectFinalsPins, resolveFinalsRow } from "../lib/finals-source.mjs";

const badge = { id: "badge", deliverable: "AI-USAGE.md", linkScope: "repo" };

test("badge pins preserve the deliverable as the authoring history input", () => {
  assert.deepEqual(selectFinalsPins(badge, { path: "" }, { kind: "dir" }), ["AI-USAGE.md", "README.md"]);
  assert.deepEqual(selectFinalsPins(badge, { path: "" }, { kind: "dir", pinned: "README.md" }), ["AI-USAGE.md", "README.md"]);
  assert.deepEqual(selectFinalsPins(badge, { path: "" }, { kind: "dir", pinned: "docs/evidence.md" }), ["AI-USAGE.md", "docs/evidence.md", "README.md"]);
});

test("ordinary documentation and direct file selection retain their behavior", () => {
  assert.deepEqual(selectFinalsPins({ sourceSubpath: "project" }, { path: "project" }, { kind: "dir", pinned: "project/report.md" }), ["project/report.md", "README.md"]);
  assert.equal(selectFinalsPins({}, { path: "report.md" }, { kind: "file" }), "report.md");
  assert.equal(selectFinalsPins({ sourceSubpath: "project" }, { path: "" }, { kind: "dir" }), "README.md");
});

test("root and direct badge links archive surrounding evidence at the deadline", () => {
  const root = mkdtempSync(join(tmpdir(), "finals-badge-"));
  const repo = join(root, "fixture");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(repo, "AI-USAGE.md"), "Evidence before deadline\n");
    writeFileSync(join(repo, "README.md"), "Project and assistant credit\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/app.js"), "export const evidence = true;\n");
    mkdirSync(join(repo, "project"));
    writeFileSync(join(repo, "project/report.md"), "Group report\n");
    mkdirSync(join(repo, "content"));
    writeFileSync(join(repo, "content/private.md"), "Instructor material\n");
    git("add", ".");
    execFileSync("git", ["-C", repo, "commit", "-qm", "Initial evidence"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z" } });
    writeFileSync(join(repo, "AI-USAGE.md"), "Later evidence\n");
    git("add", ".");
    execFileSync("git", ["-C", repo, "commit", "-qm", "Later edit"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-03T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-03T00:00:00Z" } });
    const resolve = (a, url) => resolveFinalsRow({ ws: "student-course-1-fixture", a, sub: { url, cutoff: "2026-09-02T00:00:00Z" }, owner: "course", prefix: "student-course-1-", cache: { get: () => repo }, work: root, fallback: () => null });
    for (const url of ["https://github.com/fixture/project", "https://github.com/fixture/project/blob/master/AI-USAGE.md", "https://github.com/fixture/project/blob/master/README.md"]) {
      const result = resolve(badge, url);
      assert.deepEqual(result.row.pin, ["AI-USAGE.md", "README.md"]);
      assert.equal(readFileSync(join(result.row.clone, "AI-USAGE.md"), "utf8"), "Evidence before deadline\n");
      assert.ok(existsSync(join(result.row.clone, "src/app.js")));
      assert.equal(result.row.historyRepo, repo);
    }
    const group = resolve({ id: "docs", groupWork: true, sourceSubpath: "project", linkScope: "repo" }, "https://github.com/course/student-course-1-groupmate/blob/master/project/report.md");
    assert.deepEqual(group.row.pin, ["project/report.md", "README.md"]);
    assert.ok(existsSync(join(group.row.clone, "project/report.md")));
    assert.equal(existsSync(join(group.row.clone, "content/private.md")), false);
    assert.equal(group.row.scoped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
