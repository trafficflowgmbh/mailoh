/**
 * THE ONE PLACE A POSTGRES NOTICE IS ALLOWED TO GO.
 *
 * postgres.js defaults `onnotice` to console, so every client that omits it writes the driver's raw
 * notice OBJECT to stdout. Observed in a live worker drain:
 *
 *   { severity: 'NOTICE', code: '54000', message: 'word is too long to be indexed',
 *     detail: 'Words longer than 2047 characters are ignored.', file: 'ts_parse.c' }
 *
 * None of the hardened logger's structure — no `ts=`, no `service=`, no `event=`. The log drain is a
 * CONTROLLED surface precisely because hostile input can choose what lands in it, and a Postgres
 * notice is an uncontrolled path into it — the same hazard as any other unstructured value reaching it.
 *
 * ── WHY ONLY `severity` AND `code` CROSS THIS BOUNDARY ──────────────────────────────────────────
 *
 * Not caution — precedent. A mutation test established that the driver's own prose must not reach
 * the drain: logging `err.cause.message` under an allow-listed field went red with "the driver's
 * error MESSAGE reached the log drain", and logging `serverResponseCode` went red with "an
 * attacker-chosen serverResponseCode reached the log drain". A notice's `message`/`detail`/`hint`
 * are the same category and can carry ROW VALUES — a `RAISE NOTICE` in any function, or constraint
 * prose naming the offending value. `severity` and `code` are closed vocabularies defined by
 * Postgres, so they are facts ABOUT the notice rather than content FROM it.
 *
 * The consequence is deliberate and worth stating: this DISCARDS diagnostics. The 54000 notice above
 * would survive here only as `{severity: 'NOTICE', code: '54000'}`. That is the correct trade — the
 * alternative on offer was not "structured detail", it was the raw object on stdout.
 *
 * ── WHY A SINK AND NOT A LOGGER IMPORT ─────────────────────────────────────────────────────────
 *
 * `packages/core` imports `@trafficflow/db` (see `adapters/drizzle-repo.ts`), so core → db. This
 * package therefore CANNOT import core's hardened logger without creating a cycle. The host that
 * owns a logger injects it once at boot; until it does, notices are dropped. Dropping is not a
 * silent failure mode here — it is strictly better than the default, which is the bug.
 */

/** The closed set of facts about a notice that may leave this module. */
export interface PgNoticeFacts {
  severity: string | null;
  code: string | null;
}

export type NoticeSink = (facts: PgNoticeFacts) => void;

let sink: NoticeSink | null = null;

/**
 * Install the process's notice sink. Called once at boot by a host that owns a structured logger;
 * pass `null` to go back to dropping. Not per-client: a notice carries nothing that identifies which
 * pool produced it, so a per-client sink would imply an attribution this data cannot support.
 */
export function setNoticeSink(next: NoticeSink | null): void {
  sink = next;
}

/** Test seam only — asserts the default really is "drop", which is the whole point of the module. */
export function noticeSinkInstalled(): boolean {
  return sink !== null;
}

/**
 * The shape of a hardened logger, described STRUCTURALLY so this package never imports one.
 * `packages/core`'s `Logger` satisfies it without a nominal dependency, which is what keeps the
 * core → db direction intact.
 */
export interface NoticeLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  info(event: string, fields: Record<string, unknown>): void;
}

/**
 * Build the sink a host installs at boot: `setNoticeSink(noticeSinkFor(log))`.
 *
 * ONE mapping, in one place, rather than each host writing its own closure — N call sites each
 * remembering the grammar is exactly the drift this prevents, and the field list here is a privacy
 * boundary, not a formatting preference. `severity` and `code` are both already on the logger's `ALLOWED_FIELDS`.
 *
 * `info` and not `debug` for the non-warning case, deliberately: a dropped-by-default channel that
 * logs at debug is indistinguishable from one that is broken, and the live check for this slice is
 * "a structured `pg_notice` appears", which needs the line to actually ship.
 */
export function noticeSinkFor(log: NoticeLogger): NoticeSink {
  return (facts) => {
    const fields = { severity: facts.severity, code: facts.code };
    if (facts.severity === "WARNING") log.warn("pg_notice", fields);
    else log.info("pg_notice", fields);
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Pass as postgres.js `onnotice` at EVERY construction site. Never writes to console, and never
 * throws: a notice handler that throws would surface inside the driver's message loop, turning a
 * diagnostic into a connection fault.
 */
export function onNotice(notice: unknown): void {
  if (sink === null) return;
  const o = (notice ?? {}) as Record<string, unknown>;
  try {
    sink({ severity: str(o.severity) ?? str(o.severity_local), code: str(o.code) });
  } catch {
    /* a broken sink must not become a database error */
  }
}
