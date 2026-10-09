// fuzzy.ts -- the tiered matcher behind the quick-launch overlay.
//
// Mirrors FNSTools' scripts/shared/FuzzyMatch.py function for function
// (same tiers, same folds, same numbers); keep the two in step. Pure, no
// imports.
//
// A query splits on whitespace into tokens and every token must hit the
// text (AND). A token hits at exactly one TIER, the best it can reach:
//
//   0 EXACT        the whole text is the token
//   1 PREFIX       the text starts with the token
//   2 WORD         a word of the text starts with the token      blur -> hsvBlur
//   3 SUBSTRING    the token sits inside the text                lur  -> blur
//   4 INITIALS     the token spells the first letters of words   mfo  -> movieFileOut
//   5 TYPO         a word, or its prefix, is within a bounded    nosie -> noise
//                  Damerau distance: 1 for 4..7 letters, 2 for 8+
//   6 SUBSEQUENCE  the token's letters appear in order           fbg  -> feedbackGen
//
// Tiers 0..3 are the strict matches the overlay had before; 4..6 only ever
// FILL BELOW them, so nothing that matched before ranks differently. Typo
// sits above subsequence on purpose: for a token of four or more letters,
// one slip away from a real word ("nosie") is a far stronger signal than
// its letters scattered through a longer name ("noiseSimple").
//
// Both sides are FOLDED before comparing: lower case, a few British
// spellings to American (randomise/randomize, colour/color), separators
// and camelCase humps dropped, so "movie_file" and "movieFile" are one
// string. Words are split BEFORE folding, because folding loses the humps.

export const EXACT = 0;
export const PREFIX = 1;
export const WORD = 2;
export const SUBSTRING = 3;
export const INITIALS = 4;
export const TYPO = 5;
export const SUBSEQUENCE = 6;
export const TIER_NAMES = [
  "exact", "prefix", "word", "substring", "initials", "typo", "subsequence",
] as const;

/** [tier, quality]; quality is within-tier, higher is better. */
export type Hit = [number, number];

// Spelling folds, applied per WORD and anchored at its end. Narrow on
// purpose: a fold changes typo distances, so "ise" only folds after the
// consonants British -ise verbs end in (randomise, realise, recognise,
// quantise), never "noise", "raise" or "wise". It still folds a few -ise
// nouns (promise -> promize); harmless, both sides fold alike. Capture
// groups, not lookbehind: JavaScriptCore before Safari 16.4 has none.
const SPELLING: [RegExp, string][] = [
  [/([lmnrt])is(e|es|ed|er|ers|ing|ation|ations)$/, "$1iz$2"],
  [/(l)ys(e|es|ed|er|ers|ing)$/, "$1yz$2"],
  [/^(.{3,})our(s|ed|ing|ite|ites|ful|less)?$/, "$1or$2"],
  [/^grey/, "gray"],
  [/^centre(s)?$/, "center$1"],
  [/^centred$/, "centered"],
];
const WORDS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+|[0-9]+|[\p{L}\p{N}]+/gu;

// Typo tolerance by token length: nothing under four letters (too many
// neighbours), one slip up to seven letters, two from eight.
const TYPO_MIN = 4;
const TYPO_WIDE = 8;

function spell(word: string): string {
  for (const [pattern, repl] of SPELLING) word = word.replace(pattern, repl);
  return word;
}

/** The words of a name, split on separators and camelCase humps, folded. */
export function words(text: string): string[] {
  return ((text ?? "").match(WORDS) ?? []).map((w) => spell(w.toLowerCase()));
}

/** Lower case, spelling folds, separators and humps dropped: one string. */
export function fold(text: string): string {
  return words(text).join("");
}

/** Optimal-string-alignment distance, or null past `limit`. */
export function damerau(a: string, b: string, limit: number): number | null {
  if (Math.abs(a.length - b.length) > limit) return null;
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur: number[] = new Array(lb + 1).fill(0);
    cur[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cb = b[j - 1];
      const cost = ca === cb ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb && prev2) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
    }
    if (Math.min(...cur) > limit) return null;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] <= limit ? prev[lb] : null;
}

/**
 * Quality in 0..1 when tok is a subsequence of text, else null. Rewards a
 * match that starts early and runs contiguously (the palette's original
 * scorer, kept as the lowest tier).
 */
export function subsequence(tok: string, text: string): number | null {
  if (!tok) return 0;
  if (!text) return null;
  let qi = 0;
  let runs = 0;
  let run = 0;
  let first = -1;
  for (let i = 0; i < text.length; i++) {
    if (qi < tok.length && text[i] === tok[qi]) {
      if (first === -1) first = i;
      qi++;
      run++;
    } else if (run) {
      runs = Math.max(runs, run);
      run = 0;
    }
  }
  if (qi < tok.length) return null;
  runs = Math.max(runs, run);
  const contiguity = runs / tok.length;
  const position = first >= 0 ? 1 - first / text.length : 0;
  const density = tok.length / text.length;
  return 0.5 * contiguity + 0.3 * position + 0.2 * density;
}

function typo(tk: string, ws: string[], tf: string): number | null {
  const n = tk.length;
  if (n < TYPO_MIN) return null;
  const limit = n < TYPO_WIDE ? 1 : 2;
  let best: number | null = null;
  const candidates = ws.length > 1 ? [...ws, tf] : [...ws];
  candidates.forEach((w, i) => {
    const forms = new Set<string>([w]);
    for (const cut of [n - 1, n, n + 1]) if (cut > 0 && cut < w.length) forms.add(w.slice(0, cut));
    for (const form of forms) {
      if (form.length < TYPO_MIN) continue;
      const d = damerau(tk, form, limit);
      if (d === null) continue;
      // distance first, then an earlier word, then a fuller word
      const q = 1 - d / (limit + 1) - 0.05 * Math.min(i, 9) - 0.01 * (w.length - form.length);
      if (best === null || q > best) best = q;
    }
  });
  return best;
}

/** One token against one text: [tier, quality], or null. */
export function matchToken(tok: string, text: string, ws?: string[]): Hit | null {
  const tk = fold(tok);
  if (!tk) return null;
  const wlist = ws ?? words(text);
  const tf = wlist.join("");
  if (!tf) return null;
  if (tf === tk) return [EXACT, 1];
  if (tf.startsWith(tk)) return [PREFIX, tk.length / tf.length];
  for (let i = 0; i < wlist.length; i++) {
    const w = wlist[i];
    if (w.startsWith(tk)) return [WORD, 0.5 * (tk.length / w.length) + 0.5 * (1 - i / wlist.length)];
  }
  const at = tf.indexOf(tk);
  if (at >= 0) return [SUBSTRING, 1 - at / tf.length];
  if (wlist.length >= 2 && tk.length >= 2) {
    const initials = wlist.map((w) => w[0]).join("");
    if (initials.startsWith(tk)) return [INITIALS, tk.length / initials.length];
  }
  const t = typo(tk, wlist, tf);
  if (t !== null) return [TYPO, t];
  const s = subsequence(tk, tf);
  if (s !== null) return [SUBSEQUENCE, s];
  return null;
}

/** Whitespace-split tokens, those empty after folding dropped. */
export function tokens(query: string): string[] {
  return (query ?? "").split(/\s+/).filter((t) => t && fold(t));
}

/**
 * A whole query against one text: [tier, quality], or null. Every token
 * must hit. The tier is the WORST token's; the quality is the mean over
 * tokens of (quality - tier), so a token's tier always outweighs its
 * within-tier quality: -6..1, higher is better.
 */
export function match(query: string, text: string, ws?: string[]): Hit | null {
  const toks = tokens(query);
  if (!toks.length) return [EXACT, 0];
  const wlist = ws ?? words(text);
  let worst = EXACT;
  let total = 0;
  for (const t of toks) {
    const m = matchToken(t, text, wlist);
    if (!m) return null;
    worst = Math.max(worst, m[0]);
    total += m[1] - m[0];
  }
  return [worst, total / toks.length];
}

/**
 * Best [tier, quality] for a query across several fields of one row:
 * [text, penalty, substringOnly]. The penalty is added to the tier so a
 * title hit outranks the same hit in a category (0.4) or a path (0.7);
 * substringOnly refuses the fuzzy tiers, because a subsequence over a long
 * path matches almost anything. Null when any token misses every field.
 */
export function scoreFields(query: string, fields: [string, number, boolean][]): Hit | null {
  const toks = tokens(query);
  if (!toks.length) return [EXACT, 0];
  const prepared = fields.filter(([text]) => text).map(([text, penalty, subOnly]) => ({ text, penalty, subOnly, ws: words(text) }));
  let worst = 0;
  let total = 0;
  for (const t of toks) {
    let bestTier = Infinity;
    let bestQ = 0;
    for (const f of prepared) {
      const m = matchToken(t, f.text, f.ws);
      if (!m || (f.subOnly && m[0] > SUBSTRING)) continue;
      const tier = m[0] + f.penalty;
      if (tier < bestTier || (tier === bestTier && m[1] > bestQ)) {
        bestTier = tier;
        bestQ = m[1];
      }
    }
    if (bestTier === Infinity) return null;
    worst = Math.max(worst, bestTier);
    total += bestQ - bestTier;
  }
  return [worst, total / toks.length];
}

/**
 * Drop-in for the old fuzzyScore(query, text): 0 = no match, higher =
 * better, and a better TIER is always higher than any quality in a worse
 * one. Multi-word queries AND their words with worst-tier semantics.
 *   exact 7000+, prefix 6000+, word 5000+, substring 4000+, initials 3000+,
 *   typo 2000+, subsequence 1000+ (each plus 0..700 of quality).
 */
export function fuzzyScore(query: string, text: string): number {
  const q = (query ?? "").trim();
  if (!q) return 1;
  const m = match(q, text);
  if (!m) return 0;
  return (7 - m[0]) * 1000 + (m[1] + 6) * 100;
}
