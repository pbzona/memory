import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

/**
 * Basic guardrail for a shared demo: keeps profanity and slurs out of Redis
 * Agent Memory. Uses obscenity's English dataset, which handles common
 * obfuscation (leetspeak, repeated letters) and avoids Scunthorpe-style false
 * positives. Keep in sync with `agent/lib/content-filter.ts`.
 */
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const REDACTED = "[redacted]";
const WORD_CHAR = /[\p{L}\p{N}_*@$!|']/u;

export function containsBlockedLanguage(text: string): boolean {
  return matcher.hasMatch(text);
}

/** Replaces every word that contains a match with "[redacted]". */
export function redactBlockedLanguage(text: string): string {
  const matches = matcher.getAllMatches(text, true);
  if (matches.length === 0) return text;

  // Expand each match to its whole word so partial censoring can't leak the term.
  const spans = matches
    .map(({ startIndex, endIndex }) => {
      let start = startIndex;
      let end = endIndex + 1;
      while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
      while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
      return [start, end] as const;
    })
    .sort((a, b) => a[0] - b[0]);

  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    result += text.slice(cursor, Math.max(start, cursor)) + (start >= cursor ? REDACTED : "");
    cursor = end;
  }
  return result + text.slice(cursor);
}
