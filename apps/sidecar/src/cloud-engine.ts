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
import { matchReadRoute } from "./cloud-read.js";
import { createWriteThroughProxy, type WriteThroughProxy } from "./cloud-proxy.js";
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
 * and serve the Swift client three things: `/sync` and the full mail READ surface out of the local
 * mirror (`cloud-read.ts`), and a write-through proxy (`cloud-proxy.ts`) for everything else.
 *
 * ── THE SURFACE IS NOT A SECOND MIDDLEWARE CHAIN ──────────────────────────────────────────────
 *
 * The local organizer serves the full `packages/api` route table through the full middleware chain,
 * because it answers mutations locally. A Cloud-mode install owns no mailbox — the hosted worker
 * does — so it splits the surface: READS are served from the mirror it already holds, and every
 * WRITE (and the attachment/media byte reads the mirror does not hold) is FORWARDED to Cloud with
 * the bearer. The one gate that matters over stdio is a valid launch bearer (`resolveSession`, the
 * same primitive the hosted chain uses); the hosted API applies its own gates to the forwarded call.
 *
 * Reusing `packages/api`'s `createApp` (or its `localRoutes`) would drag the whole route table —
 * and with it the IMAP adapter the `/mailboxes`, `/attachments` and `/drafts` routes carry — into
 * this module's graph, which is exactly what the census forbids. So the read table is curated in
 * `cloud-read.ts` from read services alone, and the census over this file's expanded graph proves
 * it reaches no organizer module.
 *
 * ── THE WRITE-THROUGH ECHO, AND OFFLINE ───────────────────────────────────────────────────────
 *
 * A forwarded 2xx mutation echoes `X-Sync-Seq`; the proxy waits for the mirror to pull that far
 * before answering, so the client's immediate local `/sync` re-drain already holds its own write.
 * When a pull fails the mirror goes offline and the proxy answers `503 offline_read_only` writing
 * nothing locally — `online` rides `/health` and the ready frame so the shell can say which it is.
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
  /** `Request → Response` over the mirror (reads) + the write-through proxy — the stdio surface. */
  handle(req: Request): Promise<Response>;
  /** Pull the hosted feed now, then poll. */
  start(): Promise<void>;
  /** Stop polling, close and unlock the database. */
  stop(): Promise<void>;
  /** Is the hosted account reachable? Surfaced in `/health` and the ready frame. */
  online(): boolean;
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

    const proxy: WriteThroughProxy = createWriteThroughProxy({
      auth,
      mirror,
      ...(log ? { log } : {}),
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
      // `online` is the live mirror state — the shell polls this to tell "offline mirror" apart from
      // "slow first pull", the same distinction the ready frame's `online` records at launch.
      if (req.method === "GET" && path === "/health") {
        return json({ ok: true, mode: "cloud", schemaTier: "mail", mailboxId: world.mailboxId, online: mirror.online() });
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

      // THE LOCAL READ SURFACE — GET /messages*, /threads/:id, /search, /mailboxes, /tags, /rules,
      // served from the mirror through read services alone. The census over this file's expanded
      // graph proves none of these handlers can reach the IMAP adapter, the lease or the sync loop.
      const read = matchReadRoute(req.method, path);
      if (read) {
        try {
          return await read.route.handler(req, ctxFor(core.accountId, core.userId, core.sessionId), read.params);
        } catch (err) {
          if (err instanceof ServiceError) {
            return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
          }
          throw err;
        }
      }

      // EVERYTHING ELSE IS A WRITE (or an attachment/media byte read the mirror does not hold): the
      // mailbox is the hosted worker's, so it is forwarded to Cloud with the bearer. A 2xx that
      // echoes `X-Sync-Seq` waits for the mirror to pull that far before answering; offline ⇒
      // `503 offline_read_only`, and nothing is written locally.
      return proxy.forward(req);
    };

    return {
      db,
      world,
      sessionToken: session.token,
      handle,
      online: () => mirror.online(),
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
