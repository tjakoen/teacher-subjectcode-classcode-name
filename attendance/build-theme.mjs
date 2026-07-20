// build-theme.mjs — assemble the GRAIN look into assets/grain.css for the Pages scanner.
//
// GRAIN is CONSUMED from the installed @tjakoen/grain package; its CSS is NEVER copied
// into the repo (that would fork it). Bump the version in package.json, reinstall, and
// re-run `npm run build` to pick up a new GRAIN. Source paths resolve through the
// package's own exports (import.meta.resolve), so there is no hardcoded node_modules
// path to rot, and the output is a pure product of the package.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (spec) => readFileSync(fileURLToPath(import.meta.resolve("@tjakoen/grain/" + spec)), "utf8");
const fontDataUri = (file) =>
  "data:font/woff2;base64," +
  readFileSync(fileURLToPath(import.meta.resolve("@tjakoen/grain/fonts/" + file))).toString("base64");

// The exact GRAIN pieces the scanner uses: tokens + base styling + only the components
// that appear in the markup ("pull only the component CSS you use"). The grade-as-signal
// mechanism (styles/grain.css) is intentionally omitted — the scanner has no AI/human
// provenance surface. Add "styles/grain.css" here if that ever changes.
const PARTS = [
  "styles/variables.css",                       // Sourdough tokens — REQUIRED; everything reads var(--token)
  "styles/global.css",                          // base element styling + masthead
  "components/atoms/b-text/b-text.css",         // .t / .masthead typography
  "components/atoms/b-button/b-button.css",     // .btn
  "components/atoms/b-input/b-input.css",        // .field / .field__label / .field__input
  "components/atoms/b-list/b-list.css",          // .list / .list__item
  "components/molecules/card/card.css",         // .card / .card__title / .card__body
];

let css = PARTS.map((p) => `/* ===== @tjakoen/grain/${p} ===== */\n${read(p)}`).join("\n\n");

// The scanner uses only the default Sourdough flavor, so drop variables.css's optional
// @import of the alternate themes (baguette/brioche) — they are not assembled and would
// 404. This is "pull only what you use", not an edit to GRAIN's source.
css = css.replace(/^[ \t]*@import\s+["'][^"']*["'][ \t]*;[ \t]*$/gm, "");

// Embed the Redaction fonts as data: URIs so the published site is one self-contained
// stylesheet. GRAIN ships them as url("/fonts/redaction-*.woff2") (an absolute path that
// would 404 under a project Pages path like /<repo>/) — inlining sidesteps that entirely.
css = css.replace(/url\(\s*["']?\/fonts\/([^"')]+\.woff2)["']?\s*\)/g, (_m, file) => `url("${fontDataUri(file)}")`);

const outDir = fileURLToPath(new URL("./assets/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(
  new URL("grain.css", `file://${outDir}`),
  "/* GENERATED from @tjakoen/grain by build-theme.mjs — do not edit; re-run `npm run build`. */\n" + css,
);
console.log(`assets/grain.css written (${css.length.toLocaleString()} bytes) from ${PARTS.length} GRAIN sources.`);
