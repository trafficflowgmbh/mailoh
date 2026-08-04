"use client";

/**
 * SEARCH — TWO PASSES, AND IT SAYS WHICH ONE IT IS ON (gap O14).
 *
 *  1. **This device, instantly.** `engine.search()` is synchronous over the mirror: lexical +
 *     prefix + trigram fuzzy ("invoce" finds the invoice). It answers on every keystroke with
 *     no round trip, and that is not negotiable — it is the whole reason the local index
 *     exists.
 *  2. **The whole archive, a moment later.** `engine.searchServer()` runs `GET /search` — the
 *     `websearch_to_tsquery` + `word_similarity` RRF ranking over `message_bodies.body_tsv`,
 *     which was mounted, spend-classed `read`, contract-tested and had ZERO callers on any
 *     surface. Its hits EXTEND the local ones; they never replace them.
 *
 * ── WHY THE SENTENCE UNDER THE BOX IS THE POINT ──────────────────────────────────────────
 *
 * This view used to offer the archive on Enter and answer with a toast: *"Searching the
 * server archive isn't wired up yet. These local results are complete."* They were not. The
 * local index reads subject, sender and the ≤200-character `snippet` — `m.body` is a
 * fixtures-only extra the wire `MessageDTO` has no field for — and on production that is
 * 6.23 % of stored body text: 8 262 of 9 339 bodies are longer than 200 characters, median
 * 1 566. A term past character 200 of a live-shaped row was simply not findable.
 *
 * So the scope line is not decoration. Local results arrive first and are shown first, and
 * for as long as they are all we have the view says exactly that; when the archive answers it
 * says that instead; when the archive refuses it says so and offers the retry. There is no
 * moment at which the count of hits is left to imply the corpus.
 *
 * A client with no archive behind it — `?demo=1`, and the desktop tier, whose master is the
 * IMAP mailbox — gets its own sentence rather than a hidden failure. `serverSearchAvailable()`
 * is false there and nothing is requested, which is what keeps the demo at zero network.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  folderLeaf,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type LocalSearchResult,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
} from "@ohmail/client-engine";
import { Facets, SearchBox, SearchHit, type FacetGroup } from "@ohmail/ui";
import { displayTime, PLACE_LABEL, placeLabel, senderName } from "../shell/format";

interface Filter {
  group: string;
  label: string;
}

/**
 * Derived rather than imported: `packages/client-engine/src/index.ts` is the barrel and it is
 * held by another slice, so `ServerSearchOutcome` is not re-exported yet. `Awaited<ReturnType<…>>`
 * is the same type by construction and cannot drift from the method it describes.
 */
type ServerOutcome = Awaited<ReturnType<OhmailEngine["searchServer"]>>;

/** What the archive pass is doing FOR THE QUERY CURRENTLY IN THE BOX. */
type Archive =
  | { state: "searching" }
  | { state: "ready"; items: EngineMessage[]; total: number }
  | { state: "failed"; error: string }
  | { state: "unavailable" };

/** A hit and where it came from — the archive-only ones are marked on screen. */
interface MergedHit {
  hit: EngineSearchHit;
  /** True when the archive returned it and this device's mirror does not hold the row. */
  archiveOnly: boolean;
}

/**
 * One archive request per SETTLED query, never per keystroke.
 *
 * `GET /search` is `cost: "read"` and so is not gated for an unverified account, but invariant
 * #10 is about volume, not class: a request per keystroke would be ~7 RRF queries for the word
 * "invoice" against a table that joins `message_bodies`. The local pass is what covers the
 * typing; this covers the question.
 */
const ARCHIVE_DEBOUNCE_MS = 250;

/** Rows rendered. Unchanged; it is now STATED when there are more (see `resultsShown`). */
const SHOWN = 12;

export function SearchView({
  engine,
  version,
  now,
  query,
  onQuery,
  onOpen,
  onServerSearch,
}: {
  engine: OhmailEngine;
  version: number;
  now: Date;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (hit: EngineSearchHit) => void;
  /**
   * @deprecated The archive is searched by this view now, so nothing calls this. It is still
   * declared because `app/shell/AppShell.tsx` still passes it and that file belongs to another
   * slice; delete the prop and the call together when the shell is free. It must NOT be given
   * a job in the meantime — the toast it is bound to is the claim this slice removed.
   */
  onServerSearch?: () => void;
}) {
  const t = useTranslations("search");
  const [filter, setFilter] = useState<Filter | null>(null);

  const trimmed = query.trim();
  const { result, tookMs } = useMemo(() => {
    if (!trimmed) return { result: null as LocalSearchResult | null, tookMs: 0 };
    const t0 = performance.now();
    const r = engine.search(trimmed);
    return { result: r, tookMs: Math.max(1, Math.round(performance.now() - t0)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, trimmed, version]);

  // ── the archive pass ──────────────────────────────────────────────────────
  //
  // Keyed by the query it answers. A result for a query the user has since edited is
  // DISCARDED rather than rendered: two passes over one box means the slow one can land after
  // the question changed, and showing it would attach the archive's answer to the wrong words.
  const [archive, setArchive] = useState<{ q: string; outcome: Archive } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const available = engine.serverSearchAvailable();

  useEffect(() => {
    // A single character is not a question. `tokenize` in the engine drops tokens shorter than
    // two characters, so the local arm already ignores it; asking the archive would be a
    // round trip whose answer nothing on this screen could use.
    if (trimmed.length < 2) {
      setArchive(null);
      return;
    }
    if (!available) {
      setArchive({ q: trimmed, outcome: { state: "unavailable" } });
      return;
    }
    let live = true;
    setArchive({ q: trimmed, outcome: { state: "searching" } });
    const timer = setTimeout(() => {
      // `searchServer` never rejects — the outcome is a value the UI renders, so there is no
      // unhandled promise here and no error boundary over somebody's mailbox.
      void engine.searchServer(trimmed).then((outcome: ServerOutcome) => {
        if (!live) return;
        setArchive({
          q: trimmed,
          outcome:
            outcome.state === "ready"
              ? { state: "ready", items: outcome.items, total: outcome.total }
              : outcome.state === "failed"
                ? { state: "failed", error: outcome.error }
                : { state: "unavailable" },
        });
      });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [engine, trimmed, available, retryTick]);

  /** The archive's answer, but only while it still belongs to what is in the box. */
  const current: Archive | null = archive && archive.q === trimmed ? archive.outcome : null;

  // ── merge: local first, archive-only appended ─────────────────────────────
  const merged: MergedHit[] = useMemo(() => {
    // Relevance floor over the engine's recall: a hit must carry at least
    // one exact/prefix match, or a fuzzy match against a term long enough
    // to mean something ("invoce" → "invoice" stays; "in" noise goes).
    // It applies to the LOCAL arm only — the server ranked its own arm by RRF and did not
    // hand back per-token matches to floor against.
    const out: MergedHit[] = (result?.items ?? [])
      .filter((hit) => hit.matches.some((x) => !x.fuzzy || x.term.length >= 4))
      .map((hit) => ({ hit, archiveOnly: false }));
    const seen = new Set(out.map((m) => m.hit.message.id));

    if (current?.state === "ready") {
      const reader = engine.read();
      for (const item of current.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        // PREFER THE MIRROR'S OWN ROW. It carries the optimistic overlay and this device's
        // triage/flag state; the wire item is a snapshot from before whatever the user just
        // did. The wire item is the fallback for a row the mirror does not hold — which on a
        // Cloud account means a bootstrap still draining, since `/sync` mirrors every message.
        const mine = reader.get<EngineMessage>("message", item.id);
        out.push({
          hit: { message: mine ?? item, score: 0, matches: [] },
          archiveOnly: mine === undefined,
        });
      }
    }
    return out;
  }, [result, current, engine]);

  const items = useMemo(() => {
    if (!filter) return merged;
    return merged.filter(({ hit: { message: m } }) => {
      // Must match how the facets below are keyed, leaf fallback included.
      if (filter.group === "folder")
        return (VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder)) === filter.label;
      if (filter.group === "from")
        return (m.from.name ?? m.from.address) === filter.label;
      if (filter.group === "refine") return m.hasAttachments;
      return true;
    });
  }, [merged, filter]);

  /**
   * Facets are counted over the MERGED set, not over `result.facets`.
   *
   * The engine's facets describe the local arm alone. Once the archive lands, rendering them
   * beside a longer list would put "From · Anna · 3" above seven visible Anna results — a
   * smaller, quieter version of exactly the claim this slice exists to remove. Counted from
   * `merged` (before the facet filter, so clicking one does not zero the others).
   */
  const facetGroups: FacetGroup[] = useMemo(() => {
    if (!result) return [];
    const senders = new Map<string, number>();
    const folders = new Map<string, number>();
    let attachments = 0;
    for (const { hit: { message: m } } of merged) {
      const who = m.from.name ?? m.from.address;
      senders.set(who, (senders.get(who) ?? 0) + 1);
      // View id where a view exists, else the folder's LEAF — never the raw namespaced path,
      // which is what would otherwise reach the screen for a folder this client has no view for.
      const view = VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder);
      folders.set(view, (folders.get(view) ?? 0) + 1);
      if (m.hasAttachments) attachments++;
    }
    const groups: FacetGroup[] = [];
    if (senders.size) {
      groups.push({
        title: t("facetFrom"),
        items: [...senders.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, count]) => ({ label, count })),
      });
    }
    if (folders.size) {
      groups.push({
        title: t("facetFolder"),
        items: [...folders.entries()].map(([view, count]) => ({
          label: PLACE_LABEL[view] ?? view,
          count,
        })),
      });
    }
    if (attachments > 0) {
      groups.push({
        title: t("facetRefine"),
        items: [{ label: t("facetAttachment"), count: attachments }],
      });
    }
    return groups;
  }, [result, merged, t]);

  const onFacet = (groupTitle: string, label: string) => {
    const group =
      groupTitle === t("facetFrom")
        ? "from"
        : groupTitle === t("facetFolder")
          ? "folder"
          : "refine";
    // Facet labels arrive display-formatted; map folders back to view ids.
    const value =
      group === "folder"
        ? (Object.entries(PLACE_LABEL).find(([, v]) => v === label)?.[0] ?? label)
        : label;
    setFilter((f) =>
      f && f.group === group && f.label === value ? null : { group, label: value },
    );
  };

  const isEgg = trimmed.toLowerCase() === "blanc" && items.length === 0;

  /**
   * THE HONEST SENTENCE. One of five, and one of them is always on screen while a query is.
   *
   * `scopeDevice` is the load-bearing one: it is what the view says while only local results
   * are in hand, and it names the three fields the local index actually reads plus the count
   * of messages whose full text this device holds. That count is `LocalSearchResult.coverage`,
   * measured at index time — not a constant, because it grows every time somebody opens a
   * message and U5-BODY hydrates it.
   */
  const scope = !result ? null : current === null || current.state === "searching" ? (
    <>
      {t("scopeDevice", { full: result.coverage.full })} {t("scopeSearching")}
    </>
  ) : current.state === "unavailable" ? (
    <>
      {t("scopeDevice", { full: result.coverage.full })} {t("scopeNoArchive")}
    </>
  ) : current.state === "failed" ? (
    <>
      {t("scopeFailed", { reason: current.error })}{" "}
      <button type="button" className="btn ghost" onClick={() => setRetryTick((n) => n + 1)}>
        {t("scopeRetry")}
      </button>
    </>
  ) : (
    <>{t("scopeArchive", { total: current.total })}</>
  );

  return (
    <section className="view col view-search">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="search-wrap">
          <SearchBox
            value={query}
            onChange={(v) => {
              setFilter(null);
              onQuery(v);
            }}
            /* Enter re-asks the ARCHIVE. It used to fire a toast claiming the archive was not
               wired up and that these results were complete; both halves of that were false. */
            onSubmit={() => {
              if (trimmed && !isEgg && available) setRetryTick((n) => n + 1);
            }}
            placeholder={t("placeholder")}
            ariaLabel={t("aria")}
            autoFocus
          />
          {trimmed === "" ? null : isEgg ? (
            <div className="empty">
              <span className="glyph">🤍</span>
              <b>{t("eggTitle")}</b>
              {t("eggHint")}
            </div>
          ) : items.length === 0 ? (
            /* "Nothing here" is a claim too, and its size depends on which pass has answered.
               The scope line is rendered INSIDE the empty state for that reason: an empty
               result while the archive is still running must not read as an empty corpus. */
            <div className="empty">
              <span className="glyph">🌫</span>
              <b>{current?.state === "ready" ? t("emptyTitleAll") : t("emptyTitle")}</b>
              {scope}
            </div>
          ) : (
            <>
              <div className="results-head num">
                <b>{t("resultsHead", { count: items.length })}</b>
                {t("resultsMeta", { ms: tookMs })}
                {/* The list is capped at 12 rows and always was. That was quiet when only the
                    local arm fed it; with the archive merged in the gap between the count and
                    the rows widens, so it is stated. */}
                {items.length > SHOWN ? <> · {t("resultsShown", { shown: SHOWN })}</> : null}
                {filter ? <> · {t("filtered")}</> : null}
              </div>
              {/* `.results-head` again rather than a new class: `app/app.css` and
                  `packages/ui` both belong to other slices right now, so this line takes the
                  12px/--ink2 treatment that already exists instead of shipping unstyled text.
                  A `.search-scope` rule of its own is owed. */}
              <div className="results-head">{scope}</div>
              <div className="search-cols">
                <div>
                  {items.slice(0, SHOWN).map(({ hit, archiveOnly }) => (
                    <Hit
                      key={hit.message.id}
                      hit={hit}
                      now={now}
                      onOpen={onOpen}
                      archiveOnly={archiveOnly}
                    />
                  ))}
                </div>
                <Facets groups={facetGroups} onPick={onFacet} />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Hit({
  hit,
  now,
  onOpen,
  archiveOnly,
}: {
  hit: EngineSearchHit;
  now: Date;
  onOpen: (hit: EngineSearchHit) => void;
  /** The archive returned it and this device's mirror has no row for it — say so. */
  archiveOnly: boolean;
}) {
  const t = useTranslations("search");
  const m = hit.message;
  const fuzzy = hit.matches.find((x) => x.fuzzy);

  // Highlight the first exact/prefix-matched term inside the subject.
  const subject = useMemo(() => {
    const exact = hit.matches.find((x) => !x.fuzzy);
    if (!exact) return <>{m.subject}</>;
    const idx = m.subject.toLowerCase().indexOf(exact.term.toLowerCase());
    if (idx < 0) return <>{m.subject}</>;
    return (
      <>
        {m.subject.slice(0, idx)}
        <mark>{m.subject.slice(idx, idx + exact.term.length)}</mark>
        {m.subject.slice(idx + exact.term.length)}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit]);

  const where = `${placeLabel(m.folder)} · ${displayTime(m, now)}${
    archiveOnly ? ` · ${t("hitArchiveOnly")}` : ""
  }`;

  return (
    <SearchHit
      who={senderName(m)}
      where={where}
      subject={subject}
      fuzzyNote={fuzzy ? t("fuzzyNote", { term: fuzzy.term }) : undefined}
      onPress={() => onOpen(hit)}
    />
  );
}
