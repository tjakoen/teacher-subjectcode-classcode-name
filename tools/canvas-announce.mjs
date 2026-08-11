#!/usr/bin/env node
// Post a course announcement to Canvas from a repo-owned Markdown file.
//
// The repo stays the source of truth: announcements/<id>.md is written, reviewed
// and committed like any other course content, and this pushes it to Canvas as a
// course announcement. Useful when the Canvas UI is not reachable, and it means
// what students were told is in git next to the thing it was about.
//
// DRY RUN BY DEFAULT: renders the HTML and prints it, posts nothing until
// --execute. After posting it READS THE ANNOUNCEMENT BACK so you can confirm
// what Canvas actually stored.
//
// Auth (same as canvas-push):
//   CANVAS_BASE_URL, CANVAS_TOKEN, and CANVAS_COURSE_ID (or --course=<id>).
//
// Usage:
//   node tools/canvas-announce.mjs <announcementId> [options]
//   node tools/canvas-announce.mjs m4-m5-quizzes-open --execute
//
// Options:
//   --course=<id>     override CANVAS_COURSE_ID
//   --delay=<when>    schedule it (delayed_post_at) instead of posting now
//   --tz=<offset>     offset for a --delay written without one (default +08:00)
//   --force           post even if an announcement with this title already exists
//   --execute         actually post; otherwise dry run
//
// The file's first "# Heading" line becomes the announcement title; everything
// after it is the body. Supported Markdown: paragraphs, ## and ### headings,
// - bullet lists, **bold**, and `inline code`.

import fs from "node:fs";
import path from "node:path";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const positional = process.argv.slice(2).find((x) => !x.startsWith("--"));
const id = positional || arg("id");
const execute = has("execute");
const force = has("force");
const courseId = arg("course") || process.env.CANVAS_COURSE_ID || "";
const BASE = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CANVAS_TOKEN || "";
const TZ = arg("tz", "+08:00");

if (!id) { console.error("usage: canvas-announce.mjs <announcementId> [--execute]"); process.exit(1); }
if (!courseId) { console.error("no course: set CANVAS_COURSE_ID or pass --course=<id>"); process.exit(1); }
if (!BASE || !TOKEN) { console.error("set CANVAS_BASE_URL and CANVAS_TOKEN in the environment"); process.exit(1); }

const srcPath = path.join("announcements", `${id}.md`);
if (!fs.existsSync(srcPath)) { console.error(`announcement not found: ${srcPath}`); process.exit(1); }
const raw = fs.readFileSync(srcPath, "utf8");

const lines = raw.split("\n");
const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
if (titleIdx < 0) { console.error(`${srcPath}: needs a "# Title" line to use as the announcement title`); process.exit(1); }
const title = lines[titleIdx].replace(/^#\s+/, "").trim();
const bodyMd = lines.slice(titleIdx + 1).join("\n").trim();

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A bare URL becomes a real link. Without this a student has to select and copy
// the text, which is enough friction that some of them simply will not.
// Applied AFTER escaping, so the href carries the escaped form and cannot break
// out of the attribute. Trailing sentence punctuation is left outside the link.
const linkify = (s) =>
  s.replace(/https?:\/\/[^\s<]+[^\s<.,:;"')\]]/g, (u) => `<a href="${u}">${u}</a>`);
const inline = (s) =>
  linkify(esc(s))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

// Deterministic Markdown subset: blocks separated by blank lines.
const render = (md) => {
  const out = [];
  for (const block of md.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (/^###\s+/.test(b)) { out.push(`<h4>${inline(b.replace(/^###\s+/, ""))}</h4>`); continue; }
    if (/^##\s+/.test(b)) { out.push(`<h3>${inline(b.replace(/^##\s+/, ""))}</h3>`); continue; }
    if (b.split("\n").every((l) => /^\s*-\s+/.test(l))) {
      const items = b.split("\n").map((l) => `  <li>${inline(l.replace(/^\s*-\s+/, ""))}</li>`);
      out.push(`<ul>\n${items.join("\n")}\n</ul>`);
      continue;
    }
    out.push(`<p>${b.split("\n").map(inline).join("<br>\n")}</p>`);
  }
  return out.join("\n");
};
const message = render(bodyMd);

const normalizeDate = (input) => {
  if (!input) return undefined;
  let s = String(input).trim().replace(" ", "T");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!/T\d{2}:\d{2}/.test(s)) s += "T00:00";
  if (!/T\d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(/(T\d{2}:\d{2})/, "$1:00");
  const d = new Date(hasOffset ? s : s + TZ);
  if (Number.isNaN(d.getTime())) { console.error(`cannot parse --delay ${input}`); process.exit(1); }
  return d.toISOString();
};
const delayedPostAt = normalizeDate(arg("delay"));

const api = async (p, init = {}) => {
  const url = p.startsWith("http") ? p : `${BASE}/api/v1${p}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}\n${await res.text().catch(() => "")}`);
  return res;
};
const apiJson = async (p, init) => (await api(p, init)).json();

(async () => {
  console.log(`Announcement: ${srcPath} -> Canvas course ${courseId}  (${execute ? "EXECUTE" : "DRY RUN"})`);
  console.log(`  title: ${title}`);
  if (delayedPostAt) console.log(`  scheduled for: ${delayedPostAt} (${arg("delay")} ${TZ})`);

  console.log(`\n--- rendered HTML (${message.length} chars) ---`);
  console.log(message);
  console.log("--- end ---");

  // Duplicate check. In a dry run an unreachable Canvas is a warning, not a
  // failure: the point of the dry run is to see the rendering.
  let existing = null;
  try {
    existing = await apiJson(`/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`);
  } catch (e) {
    if (execute) throw e;
    console.log(`\n(could not reach Canvas to check for a duplicate: ${e.message.split("\n")[0]})`);
  }
  const clash = existing && existing.find((t) => t.title === title);
  if (clash) {
    console.log(`\n  ALREADY POSTED: "${clash.title}" (id ${clash.id}, ${clash.posted_at || "unposted"})`);
    if (!force) { console.log("  -> skipping to avoid a duplicate. Re-run with --force to post a second copy."); process.exit(0); }
    console.log("  --force set: posting a second copy anyway.");
  }

  if (!execute) {
    console.log("\nDRY RUN - nothing posted. Re-run with --execute to post.");
    process.exit(0);
  }

  const body = { title, message, is_announcement: true, published: true };
  if (delayedPostAt) body.delayed_post_at = delayedPostAt;
  const made = await apiJson(`/courses/${courseId}/discussion_topics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const back = await apiJson(`/courses/${courseId}/discussion_topics/${made.id}`);
  console.log("\nPosted. Read back from Canvas:");
  console.log(`  id            : ${back.id}`);
  console.log(`  title         : ${back.title}`);
  console.log(`  is announcement: ${back.is_announcement === true || back.announcement === true}`);
  console.log(`  posted_at     : ${back.posted_at || "(not yet)"}`);
  console.log(`  delayed_post_at: ${back.delayed_post_at || "(none)"}`);
  console.log(`  locked        : ${back.locked}`);
  console.log(`  url           : ${back.html_url}`);
  const gotChars = (back.message || "").length;
  console.log(`  body stored   : ${gotChars} chars${gotChars === message.length ? " (unchanged)" : " (Canvas rewrote the HTML; read it in the UI if that matters)"}`);
})().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
