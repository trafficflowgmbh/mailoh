import { join } from "node:path";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core/mail";
import {
  resolveSession, syncService, ServiceError,
  type EntityType, type ServiceContext,
} from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "./db.js";
import { ensureLocalWorld, mintLaunchSession, type LocalWorld } from "./identity.js";
import {
  createCloudAuth, loadSealedTokens, sealTokens, type CloudTokens,
} from "./cloud-auth.js";
import { createCloudMirror, CLOUD_SYNC_TYPES, type CloudMirror } from "./cloud-mirror.js";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD ENGINE — a read-only mirror of a hosted account, assembled into the same stdio process
 * the shell already knows how to spawn.
 *
 * ── WHY THIS FILE EXISTS BESIDE `engine.ts`, AND WHAT IT DELIBERATELY LACKS ───────────────────
 *
 * `engine.ts` is the LOCAL organizer: an `ImapAdapter` against the user's own server, the organizer
 * lease in `@trafficflow/worker/lease`, and the shared sync loop in `@trafficflow/worker/sync`. In
 * Cloud mode the hosted worker is the single organizer, and this process must never become a
 * second one. That is not left to discipline: this module's transitive import graph reaches NONE of
 * those three — no IMAP adapter, no lease, no sync loop — and `test/cloud-engine-census.test.ts` is
 * a static census that fails the moment one of them enters the graph. The safe branch is selected
 * by construction, and `main.ts` refuses to start Cloud mode if any `OHMAIL_IMAP_*` is present at
 * all, so the IMAP path cannot be reached even by misconfiguration.
 *
 * What this engine does instead is pull (`cloud-mirror.ts`) over a bearer client (`cloud-auth.ts`)
 * and serve a read-only bridge — `/health` and `/sync` — so the Swift projection reads the mirror
 * the pull writes.
 *
 * ── THE READ BRIDGE IS NOT A SECOND MIDDLEWARE CHAIN ──────────────────────────────────────────
 *
 * The local organizer serves the full `packages/api` route table through the full middleware chain,
 * because it answers mutations (move, send, screen) that need CSRF, the spend gate and step-up. A
 * Cloud-mode install answers READS ONLY — there is nothing to mutate here, the mailbox is the
 * hosted worker's — so the two gates that matter to a read over stdio are the ones applied below:
 * a valid bearer (`resolveSession`, the same primitive the hosted chain uses) and nothing more. It
 * is not a laxer chain for the same operations; it is the correct surface for a mirror. Reusing
 * `packages/api`'s `createApp` would drag the whole route table — and with it the IMAP adapter the
 * `/mailboxes`, `/attachments` and `/drafts` routes carry — into this module's graph, which is
 * exactly what the census forbids.
 */

export interface CloudSidecarConfig {
  /** Where the local mirror lives. Created if absent; locked while open. */
  dataDir: string;
  /** The hosted API base, e.g. `https://api.ohmail.app`. */
  cloudUrl: string;
  /** The bearer/refresh pair the shell passes on FIRST launch. Absent on later launches (sealed). */
  tokens?: CloudTokens;
  /** The mailbox address this account mirrors — the local identity's address. */
  address: string;
  displayName?: string;
  /** The per-install key ring, for the token seal. Absent ⇒ tokens live in memory for this launch. */
  keks?: Record<number, Buffer>;
  log?: Diagnostic;
  now?: () => Date;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  pageLimit?: number;
  pollIntervalMs?: number;
}

export interface CloudSidecar {
  readonly db: LocalDb;
  readonly world: LocalWorld;
  /** The per-launch bearer token for the LOCAL bridge. In memory only. */
  readonly sessionToken: string;
  /** `Request → Response` over the local mirror — the read surface the stdio host serves. */
  handle(req: Request): Promise<Response>;
  /** Pull the hosted feed now, then poll. */
  start(): Promise<void>;
  /** Stop polling, close and unlock the database. */
  stop(): Promise<void>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function createCloudSidecar(config: CloudSidecarConfig): Promise<CloudSidecar> {
  const log = config.log;
  const now = config.now ?? ((): Date => new Date());

  const opened: OpenLocalDb = await openLocalDb(config.dataDir);
  try {
    const db = opened.db;
    const world = await ensureLocalWorld(db, {
      address: config.address,
      ...(config.displayName ? { displayName: config.displayName } : {}),
      now: now(),
    });
    const session = await mintLaunchSession(db, world, now());

    // ── TOKENS: SEALED WINS OVER ENVIRONMENT, THE SAME PRECEDENCE THE IMAP CREDENTIAL FOLLOWS ──
    //
    // A durable key lets a rotated token pair be sealed to disk, so a later launch resumes with no
    // token in its environment. Without a key, tokens live for this launch only and the shell must
    // pass one every time — the honest degradation, identical to the IMAP no-key case.
    const ring = config.keks ?? {};
    const versions = Object.keys(ring).map(Number).filter((v) => Number.isInteger(v) && v >= 1);
    const keyProvider: KeyProvider | undefined = versions.length > 0 ? new StaticKeyProvider(ring) : undefined;
    const sealPath = join(config.dataDir, "cloud-tokens.seal");

    const sealed = keyProvider ? await loadSealedTokens(sealPath, keyProvider) : null;
    const tokens = sealed ?? config.tokens;
    if (!tokens) {
      throw new Error(
        "Cloud mode has no session: no token is sealed on this install and none was supplied in " +
          "the environment. The shell passes OHMAIL_CLOUD_ACCESS_TOKEN / OHMAIL_CLOUD_REFRESH_TOKEN " +
          "on first launch.",
      );
    }
    // FIRST LAUNCH: seal the environment token so no later launch needs one. Skipped without a key,
    // and skipped when a sealed pair already exists — which is what keeps this idempotent.
    if (!sealed && keyProvider) {
      await sealTokens(sealPath, keyProvider, tokens);
    }

    const auth = createCloudAuth({
      baseUrl: config.cloudUrl,
      tokens,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(keyProvider ? { keyProvider } : {}),
      sealPath,
      now,
      ...(log ? { log } : {}),
    });

    const mirror: CloudMirror = createCloudMirror({
      db,
      world,
      auth,
      cursorPath: join(config.dataDir, "cloud-cursor.json"),
      ...(log ? { log } : {}),
      now,
      ...(config.pageLimit !== undefined ? { pageLimit: config.pageLimit } : {}),
      ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
    });

    const ctxFor = (accountId: string, userId: string | null, sessionId: string | null): ServiceContext => ({
      db,
      accountId,
      userId,
      sessionId,
      now,
      requestId: "",
      ip: "",
      userAgent: undefined,
      origin: undefined,
    });

    const handle = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;

      // `/health` is public: a readiness probe carries no credential, exactly as the hosted host's.
      if (req.method === "GET" && path === "/health") {
        return json({ ok: true, mode: "cloud", schemaTier: "mail", mailboxId: world.mailboxId });
      }

      // Everything else requires the launch bearer — the same `resolveSession` the hosted chain runs.
      const header = req.headers.get("authorization");
      const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
      const core = token ? await resolveSession(db, token, now()) : null;
      if (!core) return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);

      if (req.method === "GET" && path === "/sync") {
        const since = url.searchParams.get("since") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
        const typesRaw = url.searchParams.get("types");
        const valid = new Set<string>(CLOUD_SYNC_TYPES);
        const types = typesRaw
          ? (typesRaw.split(",").map((t) => t.trim()).filter((t) => valid.has(t)) as EntityType[])
          : undefined;
        try {
          const result = await syncService.getChanges(ctxFor(core.accountId, core.userId, core.sessionId), {
            since,
            ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
            ...(types && types.length > 0 ? { types } : {}),
          });
          return json(result);
        } catch (err) {
          if (err instanceof ServiceError) {
            return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
          }
          throw err;
        }
      }

      return json({ error: { code: "not_found", message: "not found" } }, 404);
    };

    return {
      db,
      world,
      sessionToken: session.token,
      handle,
      async start() {
        await mirror.start();
      },
      async stop() {
        mirror.stop();
        await opened.close();
      },
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly.
    await opened.close();
    throw err;
  }
}
