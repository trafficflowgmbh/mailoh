"use client";

/**
 * Search — the engine's instant local index: lexical + prefix + trigram
 * fuzzy ("invoce" finds the invoice), with live facets. Enter offers the
 * server archive, which the demo honestly declines.
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  folderLeaf,
  VIEW_OF_FOLDER,
  type LocalSearchResult,
  type MailohEngine,
  type SearchHit as EngineSearchHit,
} from "@mailoh/client-engine";
import { Facets, SearchBox, SearchHit, type FacetGroup } from "@mailoh/ui";
import { displayTime, PLACE_LABEL, placeLabel, senderName } from "../shell/format";

interface Filter {
  group: string;
  label: string;
}

export function SearchView({
  engine,
  version,
  now,
  query,
  onQuery,
  onOpen,
  onServerSearch,
}: {
  engine: MailohEngine;
  version: number;
  now: Date;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (hit: EngineSearchHit) => void;
  onServerSearch: () => void;
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

  const items = useMemo(() => {
    if (!result) return [];
    // Relevance floor over the engine's recall: a hit must carry at least
    // one exact/prefix match, or a fuzzy match against a term long enough
    // to mean something ("invoce" → "invoice" stays; "in" noise goes).
    const meaningful = result.items.filter((hit) =>
      hit.matches.some((x) => !x.fuzzy || x.term.length >= 4),
    );
    if (!filter) return meaningful;
    return meaningful.filter(({ message: m }) => {
      // Must match how the engine keys its folder facets, leaf fallback included.
      if (filter.group === "folder")
        return (VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder)) === filter.label;
      if (filter.group === "from")
        return (m.from.name ?? m.from.address) === filter.label;
      if (filter.group === "refine") return m.hasAttachments;
      return true;
    });
  }, [result, filter]);

  const facetGroups: FacetGroup[] = useMemo(() => {
    if (!result) return [];
    const groups: FacetGroup[] = [];
    if (result.facets.sender.length) {
      groups.push({
        title: t("facetFrom"),
        items: result.facets.sender.slice(0, 5).map((s) => ({
          label: s.name ?? s.address,
          count: s.count,
        })),
      });
    }
    const folders = Object.entries(result.facets.folder);
    if (folders.length) {
      groups.push({
        title: t("facetFolder"),
        // Safe to show a key we have no label for: the engine keys these by
        // view id or by folder LEAF, never by the raw namespaced path.
        items: folders.map(([view, count]) => ({
          label: PLACE_LABEL[view] ?? view,
          count,
        })),
      });
    }
    if (result.facets.hasAttachment.true > 0) {
      groups.push({
        title: t("facetRefine"),
        items: [{ label: t("facetAttachment"), count: result.facets.hasAttachment.true }],
      });
    }
    return groups;
  }, [result, t]);

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
            onSubmit={() => {
              if (trimmed && items.length === 0 && !isEgg) onServerSearch();
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
            <div className="empty">
              <span className="glyph">🌫</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          ) : (
            <>
              <div className="results-head num">
                <b>{t("resultsHead", { count: items.length })}</b>
                {t("resultsMeta", { ms: tookMs })}
                {filter ? <> · {t("filtered")}</> : null}
              </div>
              <div className="search-cols">
                <div>
                  {items.slice(0, 12).map((hit) => (
                    <Hit key={hit.message.id} hit={hit} now={now} onOpen={onOpen} />
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
}: {
  hit: EngineSearchHit;
  now: Date;
  onOpen: (hit: EngineSearchHit) => void;
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

  return (
    <SearchHit
      who={senderName(m)}
      where={`${placeLabel(m.folder)} · ${displayTime(m, now)}`}
      subject={subject}
      fuzzyNote={fuzzy ? t("fuzzyNote", { term: fuzzy.term }) : undefined}
      onPress={() => onOpen(hit)}
    />
  );
}
