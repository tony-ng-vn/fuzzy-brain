// Tokenizer and approximate stemmer for retrieval query analysis.
//
// Shared by the product's recall verb (scripts/recall.mjs) and the bench
// harness (experiments/recall-bench/engine.mjs), which re-exports these so the
// two can never disagree about what a query term is.
//
// Neither function ever touches SQL. Postgres does its own parsing and
// stemming inside to_tsvector/to_tsquery; everything here only feeds
// idf/rareness scoring and the query-feature rules.

// Postgres's default 'english' stopword list, trimmed to the common core.
// Approximate on purpose: this only gates what counts toward idf/oov
// scoring and the OR-lane fragment terms, not what Postgres itself matches.
export const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an",
  "and", "any", "are", "aren't", "as", "at", "be", "because", "been",
  "before", "being", "below", "between", "both", "but", "by", "can", "did",
  "do", "does", "doing", "don't", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "s",
  "same", "she", "should", "so", "some", "such", "t", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "won't", "would", "you", "your",
  "yours", "yourself", "yourselves",
]);

// Words with internal hyphens/apostrophes stay one token (planted rare
// tokens look like "kbz-4417"; splitting on "-" would hide them).
const TOKEN_RE = /[a-z0-9]+(?:[-'][a-z0-9]+)*/g;
const QUOTED_RE = /"([^"]+)"/g;

export function tokenize(text) {
  const quoted = [];
  const withoutQuotes = String(text ?? "").replace(QUOTED_RE, (_, inner) => {
    quoted.push(inner.trim().toLowerCase());
    return ` ${inner} `;
  });
  const terms = withoutQuotes.toLowerCase().match(TOKEN_RE) ?? [];
  return { terms, quoted };
}

// Suffix-stripping approximation of Porter stemming. Not a faithful Porter
// implementation -- deliberately conservative (skips -er/-est comparative
// stripping, which misfires badly on ordinary nouns like "father") since
// this only feeds idf/rareness scoring, never SQL matching.
export function stem(word) {
  let w = String(word ?? "").toLowerCase();
  if (w.length < 4) return w;
  w = w.replace(/'s$/, "");
  if (w.endsWith("ies") && w.length > 5) w = `${w.slice(0, -3)}y`;
  else if (/[^s]s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = collapseDoubled(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed")) w = collapseDoubled(w.slice(0, -2));
  if (w.endsWith("iness") && w.length > 6) w = `${w.slice(0, -5)}y`;
  else if (w.endsWith("ness") && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  return w;
}

function collapseDoubled(w) {
  // "stopp" (from "stopped") -> "stop"; leaves legitimate double letters
  // like "ll"/"ss"/"zz" alone since those are rarely stemming artifacts.
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) return w.slice(0, -1);
  return w;
}
