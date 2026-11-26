const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'more',
  'not',
  'of',
  'on',
  'or',
  'our',
  'out',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'use',
  'used',
  'using',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
]);

export interface CandidateItem {
  id: string;
  title: string;
  body?: string;
}

export interface MatchResult<T extends CandidateItem> {
  item: T;
  score: number;
}

function stemWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es') && word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function stripDetails(text: string): string {
  return text.replace(/<details>[\s\S]*?<\/details>/g, ' ');
}

export function buildMatchQuery(input: { title: string; friction: string; evidence?: string }): {
  title: string;
  body: string;
} {
  const body = [input.friction, input.evidence].filter(Boolean).join('\n');
  return { title: input.title, body };
}

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;

export function extractWords(text: string): Set<string> {
  const cleaned = stripDetails(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_-]+/gu, ' ');

  const words = new Set<string>();
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    const parts = raw.split(/[/_-]+/).filter(Boolean);
    for (const part of parts) {
      if (part.length < 2 || STOPWORDS.has(part)) continue;
      words.add(stemWord(part));
      for (const match of part.matchAll(CJK_RUN_RE)) {
        const run = match[0]!;
        for (let i = 0; i <= run.length - 2; i += 1) {
          words.add(run.slice(i, i + 2));
        }
      }
    }
  }
  return words;
}

export function extractIdentifiers(text: string): Set<string> {
  const identifiers = new Set<string>();
  const backticks = stripDetails(text).matchAll(/`([^`\n]{2,80})`/g);
  for (const match of backticks) {
    const value = match[1]?.trim().toLowerCase();
    if (value) identifiers.add(value);
  }
  return identifiers;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }
  if (shared === 0) return 0;
  const union = a.size + b.size - shared;
  const jaccard = shared / union;
  const containment = shared / Math.min(a.size, b.size);
  return 0.6 * jaccard + 0.4 * containment;
}

export function similarityScore(
  query: { title: string; body: string },
  candidate: { title: string; body?: string },
): number {
  const normalizedQuery = query.title.trim().toLowerCase();
  const normalizedCandidate = candidate.title.trim().toLowerCase();
  if (normalizedQuery.length > 0 && normalizedQuery === normalizedCandidate) {
    return 1;
  }

  const queryTitleWords = extractWords(query.title);
  const candidateTitleWords = extractWords(candidate.title);

  const titleScore = overlapScore(queryTitleWords, candidateTitleWords);

  const queryBodyWords = extractWords(`${query.title}\n${query.body}`);
  const candidateBodyWords = extractWords(`${candidate.title}\n${candidate.body ?? ''}`);
  const bodyScore = overlapScore(queryBodyWords, candidateBodyWords);

  const queryIds = extractIdentifiers(`${query.title}\n${query.body}`);
  const candidateIds = extractIdentifiers(`${candidate.title}\n${candidate.body ?? ''}`);
  let sharedIds = 0;
  for (const id of queryIds) {
    if (candidateIds.has(id)) sharedIds += 1;
  }
  const identifierBonus = sharedIds > 0 ? Math.min(0.15, sharedIds * 0.08) : 0;

  return Math.min(1, 0.7 * titleScore + 0.3 * bodyScore + identifierBonus);
}

export function findBestMatch<T extends CandidateItem>(
  query: { title: string; body: string },
  candidates: readonly T[],
  threshold: number,
): MatchResult<T> | undefined {
  let best: MatchResult<T> | undefined;
  for (const candidate of candidates) {
    const score = similarityScore(query, candidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { item: candidate, score };
    }
  }
  return best;
}
