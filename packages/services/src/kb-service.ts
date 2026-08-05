import { and, asc, eq, gt, sql } from "drizzle-orm";
import { kbEntries } from "@trafficflow/db";
import type { ServiceContext, Db } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Page, KbEntryDTO } from "./dto/types.js";

/** Default number of KB entries a retrieval returns (RAG top-k). */
const DEFAULT_K = 5;

export interface KbEntryBody {
  title: string;
  content: string;
  tags?: string[];
}

export interface ListKbOptions {
  cursor?: string;
  limit?: number;
}

function toDTO(row: typeof kbEntries.$inferSelect): KbEntryDTO {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: (row.tags as string[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Normalize the driver-specific `execute` shape: postgres-js returns an array,
 *  PGlite returns `{ rows }` (mirrors search-service). */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// pg_trgm presence is a property of the physical DB, not the request; memoize per
// Db handle so we probe `to_regprocedure` at most once per connection object
// (mirrors search-service.hasTrgm).
const trgmCache = new WeakMap<object, Promise<boolean>>();
function hasTrgm(db: Db): Promise<boolean> {
  const key = db as unknown as object;
  let p = trgmCache.get(key);
  if (!p) {
    p = db.execute(sql`select to_regprocedure('word_similarity(text,text)') is not null as ok`)
      .then((r) => Boolean(rowsOf<{ ok: boolean }>(r)[0]?.ok))
      .catch(() => false);
    trgmCache.set(key, p);
  }
  return p;
}

/** pg_trgm word-similarity floor for the fuzzy degrade (Postgres default 0.3). */
const FUZZY_THRESHOLD = 0.3;

/**
 * KbService — the account's knowledge base. Plain
 * account-scoped CRUD, REST-only (no `change_log` / EntityType growth);
 * clients refetch. PUT is a FULL replace of `title`/`content`/`tags`. `title` and
 * `content` are validated non-empty; a cross-account id is a 404.
 *
 * `retrieve` is KB's OWN lexical retrieval (NOT routed through
 * SearchService, which is hardwired to the messages/bodies joins): it queries the
 * DB-generated `kb_tsv` with `websearch_to_tsquery` ranked by `ts_rank`, with a
 * pg_trgm/ILIKE degrade (probing `to_regprocedure` like search-service's hasTrgm)
 * so it also works offline in PGlite. accountId-scoped throughout.
 */
export class KbService {
  async list(ctx: ServiceContext, opts: ListKbOptions = {}): Promise<Page<KbEntryDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(kbEntries.accountId, ctx.accountId)];
    if (opts.cursor) filters.push(gt(kbEntries.id, decodeListCursor(opts.cursor)));
    const rows = await ctx.db.select().from(kbEntries)
      .where(and(...filters)).orderBy(asc(kbEntries.id)).limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items: pageRows.map(toDTO), nextCursor };
  }

  async get(ctx: ServiceContext, id: string): Promise<KbEntryDTO> {
    const [row] = await ctx.db.select().from(kbEntries)
      .where(and(eq(kbEntries.id, id), eq(kbEntries.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "kb entry not found");
    return toDTO(row);
  }

  async create(ctx: ServiceContext, body: KbEntryBody): Promise<KbEntryDTO> {
    const title = this.validText(body.title, "title");
    const content = this.validText(body.content, "content");
    const tags = this.validTags(body.tags);
    const now = ctx.now();
    const [row] = await ctx.db.insert(kbEntries).values({
      accountId: ctx.accountId, title, content, tags, createdAt: now, updatedAt: now,
    }).returning();
    return toDTO(row!);
  }

  /** PUT /kb/:id — full replace of title/content/tags. */
  async update(ctx: ServiceContext, id: string, body: KbEntryBody): Promise<KbEntryDTO> {
    const title = this.validText(body.title, "title");
    const content = this.validText(body.content, "content");
    const tags = this.validTags(body.tags);
    const updated = await ctx.db.update(kbEntries)
      .set({ title, content, tags, updatedAt: ctx.now() })
      .where(and(eq(kbEntries.id, id), eq(kbEntries.accountId, ctx.accountId)))
      .returning();
    if (updated.length === 0) throw new ServiceError("not_found", 404, "kb entry not found");
    return toDTO(updated[0]!);
  }

  async remove(ctx: ServiceContext, id: string): Promise<void> {
    const deleted = await ctx.db.delete(kbEntries)
      .where(and(eq(kbEntries.id, id), eq(kbEntries.accountId, ctx.accountId)))
      .returning();
    if (deleted.length === 0) throw new ServiceError("not_found", 404, "kb entry not found");
  }

  /**
   * Top-k KB entries most relevant to `query`. Lexical arm: the
   * DB-generated `kb_tsv @@ websearch_to_tsquery('english', q)` ranked by
   * `ts_rank`. When pg_trgm is present the ranking also credits trigram similarity
   * over title+content (typo-tolerant); when it is absent (PGlite) the predicate
   * DEGRADES to an ILIKE-contains so retrieval still returns matches offline. A
   * blank query yields nothing (no meaningful predicate). accountId-scoped.
   */
  async retrieve(ctx: ServiceContext, query: string, k = DEFAULT_K): Promise<KbEntryDTO[]> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const limit = Math.max(1, Math.min(k, 50));

    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    const lexPred = sql`kb_tsv @@ ${tsq}`;
    const trgm = await hasTrgm(ctx.db);
    const like = `%${q}%`;
    // Fuzzy/degrade arm: pg_trgm word_similarity when present, else ILIKE-contains.
    const fuzzPred = trgm
      ? sql`(word_similarity(${q}, title) >= ${FUZZY_THRESHOLD} or word_similarity(${q}, content) >= ${FUZZY_THRESHOLD})`
      : sql`(title ilike ${like} or content ilike ${like})`;
    const fuzzRank = trgm
      ? sql`greatest(word_similarity(${q}, title), word_similarity(${q}, content))`
      : sql`0`;

    const retrieval = sql`
      select id
      from kb_entries
      where account_id = ${ctx.accountId} and (${lexPred} or ${fuzzPred})
      order by (ts_rank(kb_tsv, ${tsq}) + ${fuzzRank}) desc, updated_at desc
      limit ${limit}`;

    const hits = rowsOf<{ id: string }>(await ctx.db.execute(retrieval));

    // Re-fetch each hit as the canonical DTO, preserving ranked order. The
    // account-scoped select re-checks accountId.
    const out: KbEntryDTO[] = [];
    for (const h of hits) {
      const [row] = await ctx.db.select().from(kbEntries)
        .where(and(eq(kbEntries.id, h.id), eq(kbEntries.accountId, ctx.accountId))).limit(1);
      if (row) out.push(toDTO(row));
    }
    return out;
  }

  private validText(v: unknown, field: string): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, `${field} is required`);
    }
    return v;
  }

  private validTags(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
      throw new ServiceError("validation_failed", 400, "tags must be an array of strings");
    }
    return v as string[];
  }
}

export const kbService = new KbService();
