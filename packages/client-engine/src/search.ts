import type { EntityReader } from "./store.js";
import { folderLeaf, VIEW_OF_FOLDER, type EngineMessage } from "./types.js";

/**
 * The minimal instant local search over the mirror (brief §1: "the client should
 * ALSO run instant local search over its mirror"). Lexical tokens over
 * subject/from/snippet/body with field weighting, plus a padded-trigram fuzzy
 * arm (pg_trgm-style) so the canonical 'invoce' → "Invoice" typo case matches.
 * `/search` remains the full-corpus fallback — this covers the hot mirror.
 */

export interface SearchMatch {
  /** The query token. */
  token: string;
  /** The indexed term it matched. */
  term: string;
  fuzzy: boolean;
}

export interface SearchHit {
  message: EngineMessage;
  score: number;
  matches: SearchMatch[];
}

export interface SearchFacets {
  /** Counts per client view (ohbox/reads/receipts/…). */
  folder: Record<string, number>;
  sender: Array<{ address: string; name: string | null; count: number }>;
  hasAttachment: { true: number; false: number };
  unread: { true: number; false: number };
}

export interface LocalSearchResult {
  items: SearchHit[];
  facets: SearchFacets;
}

const FIELD_WEIGHT = { subject: 3, from: 2, text: 1 } as const;
const FUZZY_THRESHOLD = 0.4;
const MIN_FUZZY_LEN = 4;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
}

/** pg_trgm-style padded trigrams: "  t", " te", "ter", …, "rm " */
function trigrams(term: string): Set<string> {
  const padded = `  ${term} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return (2 * common) / (a.size + b.size);
}

interface Posting {
  weight: number;
}

export class SearchIndex {
  /** term → messageId → best field weight */
  private readonly postings = new Map<string, Map<string, Posting>>();
  private readonly trigramCache = new Map<string, Set<string>>();
  private readonly messages = new Map<string, EngineMessage>();

  static build(reader: EntityReader): SearchIndex {
    const idx = new SearchIndex();
    for (const m of reader.list<EngineMessage>("message")) idx.add(m);
    return idx;
  }

  private index(term: string, messageId: string, weight: number): void {
    let map = this.postings.get(term);
    if (!map) {
      map = new Map();
      this.postings.set(term, map);
      this.trigramCache.set(term, trigrams(term));
    }
    const existing = map.get(messageId);
    if (!existing || existing.weight < weight) map.set(messageId, { weight });
  }

  add(m: EngineMessage): void {
    this.messages.set(m.id, m);
    for (const t of tokenize(m.subject)) this.index(t, m.id, FIELD_WEIGHT.subject);
    for (const t of tokenize(`${m.from.name ?? ""} ${m.from.address}`)) this.index(t, m.id, FIELD_WEIGHT.from);
    for (const t of tokenize(`${m.snippet} ${m.body ?? ""}`)) this.index(t, m.id, FIELD_WEIGHT.text);
  }

  /**
   * AND-semantics across query tokens. Per token: exact term hit (×1), prefix
   * hit (×0.7), else trigram-fuzzy hit (×similarity) — annotated so the UI can
   * render 'fuzzy match — "invoice"'.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return { items: [], facets: emptyFacets() };

    // messageId → accumulated { score, matches }
    let candidates: Map<string, { score: number; matches: SearchMatch[] }> | null = null;

    for (const q of qTokens) {
      const tokenHits = new Map<string, { score: number; match: SearchMatch }>();

      const exact = this.postings.get(q);
      if (exact) {
        for (const [id, p] of exact) {
          tokenHits.set(id, { score: p.weight, match: { token: q, term: q, fuzzy: false } });
        }
      }
      // Prefix arm (as-you-type).
      for (const [term, map] of this.postings) {
        if (term === q || !term.startsWith(q)) continue;
        for (const [id, p] of map) {
          const score = p.weight * 0.7;
          const prev = tokenHits.get(id);
          if (!prev || prev.score < score) {
            tokenHits.set(id, { score, match: { token: q, term, fuzzy: false } });
          }
        }
      }
      // Fuzzy arm — typo tolerance ('invoce' → invoice).
      if (q.length >= MIN_FUZZY_LEN) {
        const qTri = trigrams(q);
        for (const [term, map] of this.postings) {
          if (term === q || term.startsWith(q)) continue;
          const sim = diceSimilarity(qTri, this.trigramCache.get(term)!);
          if (sim < FUZZY_THRESHOLD) continue;
          for (const [id, p] of map) {
            const score = p.weight * sim;
            const prev = tokenHits.get(id);
            if (!prev || prev.score < score) {
              tokenHits.set(id, { score, match: { token: q, term, fuzzy: true } });
            }
          }
        }
      }

      // AND: intersect with the running candidate set.
      if (candidates === null) {
        candidates = new Map();
        for (const [id, hit] of tokenHits) candidates.set(id, { score: hit.score, matches: [hit.match] });
      } else {
        const next = new Map<string, { score: number; matches: SearchMatch[] }>();
        for (const [id, acc] of candidates) {
          const hit = tokenHits.get(id);
          if (hit) next.set(id, { score: acc.score + hit.score, matches: [...acc.matches, hit.match] });
        }
        candidates = next;
      }
      if (candidates.size === 0) break;
    }

    const items: SearchHit[] = [...(candidates ?? new Map())]
      .map(([id, acc]) => ({ message: this.messages.get(id)!, score: acc.score, matches: acc.matches }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 50);

    return { items, facets: facetsOf(items) };
  }
}

function emptyFacets(): SearchFacets {
  return { folder: {}, sender: [], hasAttachment: { true: 0, false: 0 }, unread: { true: 0, false: 0 } };
}

function facetsOf(items: SearchHit[]): SearchFacets {
  const facets = emptyFacets();
  const senders = new Map<string, { address: string; name: string | null; count: number }>();
  for (const { message: m } of items) {
    // Facet keys are view ids where a view exists, and otherwise the folder's
    // LEAF — never the raw path. Views render these keys directly, and the
    // folder namespace still carries the pre-rebrand company name (see
    // `NAMESPACE_EXEMPTION` in @mailoh/fixtures), so a raw path here would put
    // it straight on screen for any folder this client has no view for.
    const view = VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder);
    facets.folder[view] = (facets.folder[view] ?? 0) + 1;
    const s = senders.get(m.from.address) ?? { address: m.from.address, name: m.from.name, count: 0 };
    s.count++;
    senders.set(m.from.address, s);
    facets.hasAttachment[m.hasAttachments ? "true" : "false"]++;
    facets.unread[m.unread ? "true" : "false"]++;
  }
  facets.sender = [...senders.values()].sort((a, b) => b.count - a.count);
  return facets;
}
