import type { EntityReader } from "./store.js";
import {
  FOLDER_OF_VIEW,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageStateDTO,
  type RuleDTO,
  type ScreenerSenderDTO,
  type WaterlineMeta,
} from "./types.js";

/**
 * The ONE source of truth for what each mutation MEANS locally. Both consumers
 * share it, so the optimistic view and the demo "server" can never disagree:
 *
 *  - the Engine turns effects into its optimistic OVERLAY (applied instantly,
 *    user-always-wins, dropped when the authoritative echo lands);
 *  - the FixturesAdapter turns the same effects into authoritative SyncChanges
 *    (it plays the server in ?demo mode and UI tests).
 */

export interface MutationEffect {
  type: string;
  id: string;
  /** The next entity state, or null ⇒ delete/tombstone. */
  entity: unknown | null;
  /** Present when this effect is a message folder transition. */
  move?: { from: Folder | null; to: Folder };
}

export interface EffectContext {
  now: () => Date;
  uuid: () => string;
}

const SEG_FOLDER: Record<string, Folder> = {
  screened: "ohmail/Screened",
  spam: "ohmail/Quarantine",
};

function destFolderOf(m: Extract<EngineMutation, { kind: "screener_decide" }>, sender: ScreenerSenderDTO): Folder {
  if (m.decision === "no") return "ohmail/Screened";
  const dest = m.dest ?? sender.ai?.dest ?? "ohbox";
  return SEG_FOLDER[dest] ?? FOLDER_OF_VIEW[dest as keyof typeof FOLDER_OF_VIEW] ?? "INBOX";
}

function promotedRule(
  sender: ScreenerSenderDTO,
  scope: "sender" | "domain",
  destination: Folder,
  ctx: EffectContext,
): RuleDTO {
  const iso = ctx.now().toISOString();
  return {
    id: ctx.uuid(),
    kind: scope,
    match: scope === "domain" ? sender.from.address.split("@")[1] ?? sender.from.address : sender.from.address,
    destination,
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Compute the entity-level effects of a mutation against the current local
 * state. Unknown targets yield [] — the caller decides whether that is a no-op
 * or a rejection.
 */
export function mutationEffects(reader: EntityReader, m: EngineMutation, ctx: EffectContext): MutationEffect[] {
  const iso = ctx.now().toISOString();

  switch (m.kind) {
    case "move": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg || msg.folder === m.folder) return [];
      return [{
        type: "message",
        id: msg.id,
        entity: { ...msg, folder: m.folder, updatedAt: iso } satisfies EngineMessage,
        move: { from: msg.folder, to: m.folder },
      }];
    }

    case "triage_set": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg) return [];
      if (m.state === "none") {
        return [
          { type: "message_state", id: m.messageId, entity: null },
          { type: "message", id: msg.id, entity: { ...msg, triage: null, updatedAt: iso } },
        ];
      }
      const state: MessageStateDTO = {
        messageId: m.messageId,
        state: m.state,
        bubbleUpAt: m.bubbleUpAt ?? null,
        setAt: iso,
        updatedAt: iso,
      };
      return [
        { type: "message_state", id: m.messageId, entity: state },
        { type: "message", id: msg.id, entity: { ...msg, triage: state, updatedAt: iso } },
      ];
    }

    case "screener_decide": {
      const sender = reader.get<ScreenerSenderDTO>("screener_sender", m.senderId);
      if (!sender) return [];
      const scope = m.scope ?? sender.scope ?? "sender";
      const destination = destFolderOf(m, sender);
      const effects: MutationEffect[] = [];

      if (m.decision === "yes") {
        // Yes → the sender's held mail is filed into the destination; "&read"
        // seen-semantics: the held mail lands already-seen (previously_seen,
        // not new_for_you). The waiting entry disappears; a promoted rule
        // remembers the decision.
        sender.held.forEach((held, i) => {
          const msg: EngineMessage = {
            id: ctx.uuid(),
            accountId: "demo",
            mailboxId: "lichtgrat",
            threadId: null,
            messageIdHeader: null,
            subject: held.subject,
            from: sender.from,
            to: [],
            cc: [],
            date: new Date(ctx.now().getTime() - i * 60_000).toISOString(),
            folder: destination,
            snippet: held.body.split("\n")[0] ?? "",
            unread: !m.read,
            hasAttachments: false,
            attachmentCount: 0,
            sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
            triage: null,
            labels: [],
            remoteContent: held.trackerNote ? "blocked" : "none",
            updatedAt: iso,
            body: held.body,
            time: held.time,
            ...(held.trackerNote ? { trackerNote: held.trackerNote } : {}),
          };
          effects.push({ type: "message", id: msg.id, entity: msg });
        });
        effects.push({ type: "screener_sender", id: sender.id, entity: null });
      } else {
        // No → the sender moves to the screened-out ledger (reversible; the
        // fixture world keeps the entry, segment-flipped). The whole held bag
        // travels with it — screening out holds mail, it never discards it.
        effects.push({
          type: "screener_sender",
          id: sender.id,
          entity: {
            ...sender,
            segment: "screened_out",
            screenedOn: iso.slice(0, 10),
            updatedAt: iso,
          } satisfies ScreenerSenderDTO,
        });
      }
      const rule = promotedRule(sender, scope, destination, ctx);
      effects.push({ type: "rule", id: rule.id, entity: rule });
      return effects;
    }

    case "tag_assign": {
      const msg = reader.get<EngineMessage>("message", m.messageId);
      if (!msg) return [];
      const labels = m.labels ?? (
        m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId)
      );
      return [{ type: "message", id: msg.id, entity: { ...msg, labels, updatedAt: iso } }];
    }

    case "feed_mark_seen": {
      const feed = reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === "ohmail/Reads");
      const targets = m.messageIds
        ? feed.filter((msg) => m.messageIds!.includes(msg.id))
        : feed.filter((msg) => msg.unread);
      const effects: MutationEffect[] = targets.map((msg) => ({
        type: "message",
        id: msg.id,
        entity: { ...msg, unread: false, updatedAt: iso },
      }));
      const newest = [...feed].sort((a, b) => Date.parse(b.date ?? "0") - Date.parse(a.date ?? "0"))[0];
      const afterId = m.upToId ?? newest?.id;
      if (afterId) {
        const now = ctx.now();
        const hh = String(now.getUTCHours()).padStart(2, "0");
        const mm = String(now.getUTCMinutes()).padStart(2, "0");
        effects.push({
          type: "view_meta",
          id: "reads_waterline",
          entity: { afterId, label: "Seen up to here", meta: `last visit · ${hh}:${mm}` } satisfies WaterlineMeta,
        });
      }
      return effects;
    }

    case "draft_accept": {
      const draft = reader.get<EngineDraft>("draft", m.draftId);
      if (!draft) return [];
      return [{ type: "draft", id: draft.id, entity: { ...draft, accepted: true, updatedAt: iso } }];
    }
  }
}
