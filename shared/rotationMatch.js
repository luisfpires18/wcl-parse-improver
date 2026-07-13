// Rotation-similarity math, shared VERBATIM by the server (analysis/spikes.js)
// and the browser (public/js/chart.js, for the brushed-window numbers). It lived
// in both places once and the two copies could drift into reporting different
// percentages for the same two runs — which is exactly the bug this metric
// exists to avoid. One implementation, imported by both.
//
// Plain ESM with no Node or DOM dependency, so it loads unchanged in either.
// The server imports it by relative path; the browser gets it from /shared/
// (see the static mount in server/index.js).

/**
 * Total-variation MATCH (0-100) of two count maps read as probability
 * distributions: 100·(1 − ½Σ|pᵢ−qᵢ|). Reads as "the % of mass landing on the
 * same key in the same proportion".
 *
 * Deliberately NOT cosine. Cosine of raw cast-count vectors is magnitude-
 * dominated (a handful of big shared components pin it near 100) and
 * scale-invariant (double every count, still 100), so any two runs of the same
 * spec score ~99% and the number tells you nothing. TV match spreads out
 * honestly: real top-player comparisons land ~84-91% on spell mix and ~65-75%
 * on cast order, where cosine reported 97-100% / 83-97%.
 *
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number} 0-100
 */
export function distributionMatch(a, b) {
  const ta = [...a.values()].reduce((x, y) => x + y, 0) || 1;
  const tb = [...b.values()].reduce((x, y) => x + y, 0) || 1;
  let tv = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    tv += Math.abs((a.get(k) ?? 0) / ta - (b.get(k) ?? 0) / tb);
  }
  return 100 * (1 - tv / 2);
}

/** Consecutive-pair (bigram) counts of a sequence — the order-sensitive signal. */
export function bigramCounts(seq) {
  const m = new Map();
  for (let i = 0; i + 1 < seq.length; i++) {
    const k = `${seq[i]}>${seq[i + 1]}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Order-sensitive rotation match: TV match of cast-transition (bigram)
 * distributions. The same spells in a different order score below 100.
 * @param {string[]} seqA
 * @param {string[]} seqB
 * @returns {number} 0-100
 */
export function bigramMatch(seqA, seqB) {
  return distributionMatch(bigramCounts(seqA), bigramCounts(seqB));
}

/** Tally a list of names into a count map (the spell-mix vector). */
export function countByName(names) {
  const m = new Map();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return m;
}
