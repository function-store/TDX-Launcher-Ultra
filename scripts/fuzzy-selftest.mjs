// Regression gate for src/fuzzy.ts, the tiered quick-launch matcher.
//
//   node scripts/fuzzy-selftest.mjs      (or: npm run test:fuzzy)
//
// This repo has no JavaScript test runner and adding one is a separate
// decision, so this is a plain script: it type-strips src/fuzzy.ts with the
// esbuild that vite already brings, imports it from a data URL (no temp
// files), and asserts. Exits non-zero on the first failing case, so it can
// gate a release without any framework.
//
// The cases come from FNSTools' tests/test_fuzzy_match.py — the two matchers
// are meant to stay identical, so a divergence here is a divergence there.
// The last two blocks are OURS and must not be dropped: they pin the contract
// the launcher's callers depend on (0 is the only no-match; every real match
// clears 1000) and prove the old scorer's matches all survive.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "fuzzy.ts"), "utf8");

// Lookbehind would ship fine here (node has it) and break WebKit before
// Safari 16.4, which the app still supports — the bundler cannot transpile
// regex syntax, so this is the only place that can catch it.
if (/\(\?<[=!]/.test(src)) {
  console.error("FAIL  src/fuzzy.ts contains a regex lookbehind.");
  console.error("      JavaScriptCore has none before Safari 16.4 and the app's");
  console.error("      minimumSystemVersion is older, so it is a parse-time");
  console.error("      SyntaxError there. Use a capture group and re-emit it.");
  process.exit(1);
}

const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const F = await import("data:text/javascript," + encodeURIComponent(code));

let pass = 0;
const fails = [];
const T = F.TIER_NAMES;
const ok = (cond, label, detail) =>
  cond ? pass++ : fails.push(label + (detail ? `  [${detail}]` : ""));
const tierOf = (q, t) => {
  const m = F.matchToken(q, t);
  return m ? T[m[0]] : "null";
};
const band = (n) => (n === 0 ? "none" : Math.floor(n / 1000) * 1000);

// --- folds. The negatives matter most: a fold changes typo distances, so
// "noise", "raise", "four" and "flour" must survive untouched.
for (const [i, o] of [
  ["randomise", "randomize"], ["randomisation", "randomization"], ["noise", "noise"],
  ["raise", "raise"], ["colour", "color"], ["behaviour", "behavior"], ["hour", "hour"],
  ["four", "four"], ["flour", "flour"], ["greyscale", "grayscale"],
]) ok(F.fold(i) === o, `fold ${i} -> ${o}`, F.fold(i));

ok(
  F.fold("Movie File In") === F.fold("movieFileIn") &&
    F.fold("movieFileIn") === F.fold("movie_file_in"),
  "fold: separators and camelCase humps agree",
  [F.fold("Movie File In"), F.fold("movieFileIn"), F.fold("movie_file_in")].join(" / "),
);

// --- word splitting
for (const [i, o] of [
  ["hsvBlur", ["hsv", "blur"]], ["HSVBlur", ["hsv", "blur"]],
  ["movie_file_in2", ["movie", "file", "in2"]],
]) ok(JSON.stringify(F.words(i)) === JSON.stringify(o), `words ${i}`, JSON.stringify(F.words(i)));

// --- bounded edit distance
for (const [a, b, l, e] of [
  ["nosie", "noise", 1, 1], ["fedback", "feedback", 1, 1], ["kinnect", "kinect", 1, 1],
  ["quik", "quit", 1, 1], ["abcd", "wxyz", 1, null], ["feedbakc", "feedback", 2, 1],
]) ok(F.damerau(a, b, l) === e, `damerau ${a}/${b} limit ${l} = ${e}`, String(F.damerau(a, b, l)));

// --- every tier, including the two that must NOT fire (3 letters get no typo
// tier; an empty token matches nothing)
for (const [q, t, e] of [
  ["noise", "noise", "exact"], ["noi", "noiseGen", "prefix"], ["blur", "hsvBlur", "word"],
  ["blur", "barrel_blur", "word"], ["lur", "blur", "substring"],
  ["mfo", "movieFileOut", "initials"], ["mf", "movieFileOut", "initials"],
  ["m", "movieFileOut", "prefix"], ["v", "movieFileOut", "substring"],
  ["nosie", "noise", "typo"], ["kinnect", "kinectAzure", "typo"], ["opneext", "openExt", "typo"],
  ["fbg", "feedbackGen", "subsequence"], ["nos", "nose", "prefix"],
  ["nos", "noise", "subsequence"], ["xyzq", "noise", "null"], ["", "noise", "null"],
]) ok(tierOf(q, t) === e, `tier ${JSON.stringify(q)}/${t} = ${e}`, tierOf(q, t));

// --- a whole query takes its WORST token's tier
const mt = (q, t) => {
  const m = F.match(q, t);
  return m ? T[m[0]] : "null";
};
ok(mt("curl noise", "CurlNoise") === "word", "match: curl noise -> word", mt("curl noise", "CurlNoise"));
ok(mt("curl nosie", "CurlNoise") === "typo", "match: curl nosie -> typo", mt("curl nosie", "CurlNoise"));
ok(mt("curl xyzq", "CurlNoise") === "null", "match: one miss kills the query", mt("curl xyzq", "CurlNoise"));

// --- the scores the overlay sorts on
const fs = F.fuzzyScore;
ok(fs("xyzq", "noise") === 0, "never-match is exactly 0", String(fs("xyzq", "noise")));
ok(fs("", "noise") === 1, "empty query is 1", String(fs("", "noise")));
ok(
  fs("open ext", "Open extension of current") > fs("open ext", "Open Textport"),
  "open ext: a word hit beats a substring hit",
  `${fs("open ext", "Open extension of current")} vs ${fs("open ext", "Open Textport")}`,
);
ok(fs("opne ext", "Open extension of current") > 0, "a typo still finds it", String(fs("opne ext", "Open extension of current")));
ok(
  fs("tmln", "Toggle timeline") >= 1000 && fs("tmln", "Toggle timeline") < 1700,
  "initials-ish subsequence stays in the bottom band",
  String(fs("tmln", "Toggle timeline")),
);
ok(band(fs("randomise", "Randomize colors")) === 6000, "randomise folds into the prefix band", String(fs("randomise", "Randomize colors")));
ok(band(fs("nosie", "noise")) === 2000, "nosie lands in the typo band", String(fs("nosie", "noise")));
ok(
  fs("quik", "Quit TouchDesigner") > fs("quik", "Store quickmark"),
  "quik: the whole word outranks the cut prefix",
  `${fs("quik", "Quit TouchDesigner")} vs ${fs("quik", "Store quickmark")}`,
);
ok(fs("blur", "hsvBlur") > fs("blur", "unblurred"), "blur: word beats substring",
   `${fs("blur", "hsvBlur")} vs ${fs("blur", "unblurred")}`);

// --- OURS: the contract src/quick.tsx depends on. Five call sites use
// `fuzzyScore(...) > 0` as a boolean filter, so a real match must never land
// on or below the no-match sentinel.
const corpus = [
  "noise", "CurlNoise", "feedbackGen", "Movie File In", "a", "zzzz top",
  "Toggle timeline", "hsvBlur", "openExt", "Quit TouchDesigner", "barrel_blur_chroma", "x",
];
const queries = [
  "a", "noise", "blur", "tmln", "x", "nosie", "open ext", "curl", "file in", "mfo",
  "zz", "Quit", "toggle", "gen", "chroma", "movie", "gl", "b l", "gener", "touch",
];
let min = Infinity;
for (const t of corpus) for (const q of queries) {
  const s = fs(q, t);
  if (s > 0) min = Math.min(min, s);
}
ok(min >= 1000, "every real match clears 1000, so nothing collides with 0", String(min));

// --- OURS: nothing the OLD scorer matched may stop matching. The tiers only
// fill in BELOW the old substring/subsequence behaviour, so this must hold.
function oldScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  const scoreWord = (w) => {
    const idx = t.indexOf(w);
    if (idx >= 0) return 100 - Math.min(idx, 40) + (idx === 0 || /[\s/\\._\-()[\]]/.test(t[idx - 1]) ? 25 : 0);
    let ti = 0, spread = 0, first = -1;
    for (const ch of w) {
      const found = t.indexOf(ch, ti);
      if (found === -1) return 0;
      if (first === -1) first = found;
      spread += found - ti;
      ti = found + 1;
    }
    return Math.max(1, 40 - Math.min(spread, 30) - Math.min(first, 9));
  };
  let total = 0;
  for (const w of q.split(/\s+/)) {
    const s = scoreWord(w);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}
const lost = [];
for (const t of corpus) for (const q of queries) {
  if (oldScore(q, t) > 0 && fs(q, t) === 0) lost.push(`${JSON.stringify(q)} / ${JSON.stringify(t)}`);
}
ok(lost.length === 0, "no match the old scorer found was lost", lost.slice(0, 6).join(" ; "));

console.log(`fuzzy self-test: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length ? 1 : 0);
