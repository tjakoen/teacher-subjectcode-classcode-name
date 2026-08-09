#!/usr/bin/env node
// Generate a Canvas-importable QTI 1.2 package IN the repo from a quiz's
// structured source. The teacher repo is the source of truth: quizzes/<q>/quiz.json
// is the SSOT, and this writes the portable, committed QTI artifact that Canvas
// gets (regardless of whether you import it by hand or via canvas-quiz-import.mjs).
//
// OFFLINE + DETERMINISTIC: no network, no external deps. Re-running on the same
// quiz.json produces byte-identical output (fixed zip timestamps), so the
// committed package diffs cleanly. It writes BOTH the reviewable unzipped XML
// (quizzes/<q>/canvas/package/) and the importable zip (quizzes/<q>/canvas/<q>-qti.zip).
//
// Usage: node tools/build-quiz-qti.mjs <quizId>        (e.g. q1)
//        node tools/build-quiz-qti.mjs quizzes/q1/quiz.json
//
// Supported question types: short_answer (str/exact, case-insensitive, multiple
// accepted answers) and multiple_choice (choices[] + answers[] of correct labels).
// Optional per-question "code" renders a formatted <pre><code> block under the
// prompt (for predict-the-output items). Optional top-level "namespace" prefixes
// the assessment/item idents (defaults to "haudex"); set it per course so idents
// never carry another course's theme.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const argRaw = process.argv[2];
if (!argRaw) { console.error("usage: build-quiz-qti.mjs <quizId | path/to/quiz.json>"); process.exit(1); }
const srcPath = argRaw.endsWith(".json") ? argRaw : path.join("quizzes", argRaw, "quiz.json");
if (!fs.existsSync(srcPath)) { console.error(`quiz source not found: ${srcPath}`); process.exit(1); }

const quiz = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const qid = quiz.id;
if (!qid) { console.error("quiz.json has no id"); process.exit(1); }
const ppq = quiz.pointsPerQuestion ?? 1;
const ns = quiz.namespace || "haudex";        // ident prefix (per course, not per student)

// Deterministic identifiers (no randomness), namespaced so two quizzes never collide.
const asmt = `${ns}_${qid}`;                   // assessment ident
const itemIdent = (q) => `${asmt}_${q.id}`;   // per-item ident

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// One QTI <item> per question. Question text is carried as escaped HTML (Canvas
// renders mattext texttype="text/html").
function itemXml(q, idx) {
  const type = q.type || "short_answer";
  const id = itemIdent(q);
  const title = esc(`Question ${idx + 1}`);
  const codeBlock = q.code ? `&lt;pre&gt;&lt;code&gt;${esc(q.code)}&lt;/code&gt;&lt;/pre&gt;` : "";
  const html = `&lt;p&gt;${esc(q.text)}&lt;/p&gt;${codeBlock}`;
  const meta = (label, entry) =>
    `      <qtimetadatafield><fieldlabel>${label}</fieldlabel><fieldentry>${esc(entry)}</fieldentry></qtimetadatafield>`;
  if (type === "multiple_choice") {
    const choices = q.choices || [];
    const correct = new Set((q.answers || []).map((a) => String(a)));
    const labels = choices.map((c, i) => ({ id: `${id}_c${i}`, text: c, correct: correct.has(String(c)) }));
    const responseLabels = labels.map((l) =>
      `          <response_label ident="${l.id}"><material><mattext texttype="text/plain">${esc(l.text)}</mattext></material></response_label>`).join("\n");
    const conds = labels.filter((l) => l.correct).map((l) =>
      `      <respcondition continue="No">\n        <conditionvar><varequal respident="response1">${l.id}</varequal></conditionvar>\n        <setvar action="Set" varname="SCORE">100</setvar>\n      </respcondition>`).join("\n");
    return `  <item ident="${id}" title="${title}">
    <itemmetadata>
      <qtimetadata>
${meta("question_type", "multiple_choice_question")}
${meta("points_possible", ppq.toFixed(1))}
      </qtimetadata>
    </itemmetadata>
    <presentation>
      <material><mattext texttype="text/html">${html}</mattext></material>
      <response_lid ident="response1" rcardinality="Single">
        <render_choice>
${responseLabels}
        </render_choice>
      </response_lid>
    </presentation>
    <resprocessing>
      <outcomes><decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes>
${conds}
    </resprocessing>
  </item>`;
  }
  // short_answer (fill-in-the-blank, exact/normalized match, N accepted answers)
  const answers = (q.answers || []).map((a) =>
    `          <varequal respident="response1">${esc(a)}</varequal>`).join("\n");
  return `  <item ident="${id}" title="${title}">
    <itemmetadata>
      <qtimetadata>
${meta("question_type", "short_answer_question")}
${meta("points_possible", ppq.toFixed(1))}
      </qtimetadata>
    </itemmetadata>
    <presentation>
      <material><mattext texttype="text/html">${html}</mattext></material>
      <response_str ident="response1" rcardinality="Single">
        <render_fib><response_label ident="answer1"/></render_fib>
      </response_str>
    </presentation>
    <resprocessing>
      <outcomes><decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes>
      <respcondition continue="No">
        <conditionvar>
          <or>
${answers}
          </or>
        </conditionvar>
        <setvar action="Set" varname="SCORE">100</setvar>
      </respcondition>
    </resprocessing>
  </item>`;
}

const assessmentXml = `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/ims_qtiasiv1p2 http://www.imsglobal.org/profile/cc/ccv1p1/ccv1p1_qtiasiv1p2p1_v1p0.xsd">
  <assessment ident="${asmt}" title="${esc(quiz.title || qid)}">
    <qtimetadata>
      <qtimetadatafield><fieldlabel>cc_maxattempts</fieldlabel><fieldentry>1</fieldentry></qtimetadatafield>
    </qtimetadata>
    <section ident="root_section">
${quiz.questions.map((q, i) => itemXml(q, i)).join("\n")}
    </section>
  </assessment>
</questestinterop>
`;

const totalPoints = (quiz.questions.length * ppq).toFixed(1);
const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<quiz identifier="${asmt}" xmlns="http://canvas.instructure.com/xsd/cccv1p0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://canvas.instructure.com/xsd/cccv1p0 https://canvas.instructure.com/xsd/cccv1p0.xsd">
  <title>${esc(quiz.title || qid)}</title>
  <description>${esc(quiz.description || "")}</description>
  <quiz_type>assignment</quiz_type>
  <points_possible>${totalPoints}</points_possible>
  <scoring_policy>keep_highest</scoring_policy>
  <allowed_attempts>1</allowed_attempts>
  <published>false</published>
  <available>false</available>
  <shuffle_answers>false</shuffle_answers>
  <show_correct_answers>true</show_correct_answers>
</quiz>
`;

const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${asmt}_manifest" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 http://www.imsglobal.org/xsd/imscp_v1p1.xsd">
  <metadata>
    <schema>IMS Content</schema>
    <schemaversion>1.1.3</schemaversion>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="${asmt}" type="imsqti_xmlv1p2" href="${asmt}/${asmt}.xml">
      <file href="${asmt}/${asmt}.xml"/>
      <dependency identifierref="${asmt}_meta"/>
    </resource>
    <resource identifier="${asmt}_meta" type="associatedcontent/imscc_xmlv1p1/learning-application-resource" href="${asmt}/assessment_meta.xml">
      <file href="${asmt}/assessment_meta.xml"/>
    </resource>
  </resources>
</manifest>
`;

// The package's virtual layout (paths inside the zip == the reviewable dir tree).
const files = [
  { name: "imsmanifest.xml", body: manifestXml },
  { name: `${asmt}/${asmt}.xml`, body: assessmentXml },
  { name: `${asmt}/assessment_meta.xml`, body: metaXml },
];

// ---- write the reviewable, unzipped XML tree --------------------------------
const canvasDir = path.join(path.dirname(srcPath), "canvas");
const pkgDir = path.join(canvasDir, "package");
fs.rmSync(pkgDir, { recursive: true, force: true });
for (const f of files) {
  const dest = path.join(pkgDir, f.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.body);
}

// ---- deterministic store+deflate zip (no external deps) ---------------------
// Minimal ZIP writer. Fixed DOS timestamp (1980-01-01 00:00:00) so the committed
// zip is byte-stable across runs. Deflate via zlib.deflateRawSync (deterministic).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const DOS_TIME = 0;       // 00:00:00
const DOS_DATE = 0x21;    // 1980-01-01  ((1980-1980)<<9 | 1<<5 | 1)

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.body, "utf8");
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = comp.length < raw.length;
    const data = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0, 6);         // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);        // extra len
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0, 8);         // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra
    ch.writeUInt16LE(0, 32);        // comment
    ch.writeUInt16LE(0, 34);        // disk
    ch.writeUInt16LE(0, 36);        // internal attrs
    ch.writeUInt32LE(0, 38);        // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const zipPath = path.join(canvasDir, `${qid}-qti.zip`);
fs.mkdirSync(canvasDir, { recursive: true });
fs.writeFileSync(zipPath, zip(files));

console.log(`QTI package written for ${qid} (${quiz.questions.length} questions, ${totalPoints} pts)`);
console.log(`  reviewable XML : ${pkgDir}/`);
console.log(`  import zip     : ${zipPath}`);
