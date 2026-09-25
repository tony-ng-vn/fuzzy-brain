import { STOPWORDS, stem, tokenize } from "./text.mjs";

export function evidenceExcerpt(text, question, limit = 700) {
  let offset = 0;
  if (text.length > limit) {
    const wanted = new Set(tokenize(question).terms.filter(term => !STOPWORDS.has(term)).slice(0, 32).map(stem));
    const window = [], counts = new Map();
    let head = 0, bestCount = 0, bestSpan = Infinity;
    // Keep only a moving window of matches; a repeated word in a long paste must not grow memory without bound.
    if (wanted.size) for (const token of text.matchAll(/[a-z0-9]+(?:[-'][a-z0-9]+)*/gi)) {
      const term = stem(token[0]);
      if (!wanted.has(term) || token[0].length > limit) continue;
      const match = { term, start: token.index, end: token.index + token[0].length };
      window.push(match);
      counts.set(term, (counts.get(term) ?? 0) + 1);
      while (match.end - window[head].start > limit) {
        const first = window[head++];
        const remaining = counts.get(first.term) - 1;
        if (remaining) counts.set(first.term, remaining);
        else counts.delete(first.term);
      }
      const span = match.end - window[head].start;
      if (counts.size > bestCount || (counts.size === bestCount && span < bestSpan)) {
        bestCount = counts.size;
        bestSpan = span;
        const center = Math.floor((window[head].start + match.end) / 2);
        offset = Math.max(0, Math.min(text.length - limit, center - Math.floor(limit / 2)));
      }
      if (head >= 128) { window.splice(0, head); head = 0; }
    }
  }
  // Offsets use the same UTF-16 indexing as read_evidence, without cutting a surrogate pair.
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) offset++;
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { text: text.slice(offset, end), offset, truncated: offset > 0 || end < text.length };
}
