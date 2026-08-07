import { and, asc, eq, inArray } from "drizzle-orm";
import type { EmailAddress } from "@trafficflow/core/mail";
import {
  messages, folderState, messageStates, threads, routingDecisions, approvals, rules, drafts,
  tags, messageTags,
  type EntityType,
} from "@trafficflow/db";
import type { Db } from "../context.js";
import type {
  Folder, MessageDTO, MessageStateDTO, ThreadDTO, RoutingDecisionDTO, ApprovalDTO, RuleDTO,
  DraftDTO, DraftStatus, SensitivityFlags, TriageState, TagDTO,
} from "./types.js";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function stateRowToDTO(r: typeof messageStates.$inferSelect): MessageStateDTO {
  return {
    messageId: r.messageId,
    state: r.state as TriageState,
    bubbleUpAt: iso(r.bubbleUpAt),
    setAt: r.setAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * ONE message row → its DTO. Pure: every read has already happened.
 *
 * Extracted so the single-id path and the batch path cannot drift. They used to be the same
 * function because there WAS only one path, and the cost of that hid in `SyncService`, which
 * called it once per `change_log` row — three sequential round-trips per message, 1 500 for a
 * 500-row page. At real database round-trip latency that pushed a single page past the function
 * timeout and a full bootstrap into the minutes, so the first page timed out and the client
 * received NOTHING. On a large mailbox every view rendered empty.
 */
function messageRowToDTO(
  m: typeof messages.$inferSelect,
  fs: typeof folderState.$inferSelect | undefined,
  st: typeof messageStates.$inferSelect | undefined,
  labels: readonly string[] | undefined,
): MessageDTO {
  const loc = (m.nativeLocator as { folder?: string } | null) ?? null;
  const folder = (fs?.desiredFolder ?? loc?.folder ?? "INBOX") as Folder;
  const category = (m.sensitivityCategory as SensitivityFlags["category"]) ?? null;
  const sensitivity: SensitivityFlags = {
    sensitive: category !== null || m.noAi || m.noForward || m.noKb || m.priority,
    category,
    no_ai: m.noAi, no_forward: m.noForward, no_kb: m.noKb, priority: m.priority,
  };

  return {
    id: m.id,
    accountId: m.accountId,
    mailboxId: m.mailboxId,
    threadId: m.threadId ?? null,
    messageIdHeader: m.messageIdHeader ?? null,
    subject: m.subject,
    from: { name: null, address: m.fromAddress },
    to: (m.toAddresses as EmailAddress[]) ?? [],
    cc: (m.ccAddresses as EmailAddress[]) ?? [],
    date: iso(m.date),
    folder,
    snippet: m.snippet,
    unread: m.unread,
    hasAttachments: m.hasAttachments,
    attachmentCount: m.attachmentCount,
    sensitivity,
    triage: st ? stateRowToDTO(st) : null,
    // The tag ids on this message. This was a hardcoded `[]` in an early build until the tags
    // backend landed, which is what made the built tag UI inert in production: the
    // client filters `tags` by `m.labels.includes(tag.id)`, so an always-empty array meant no
    // message ever carried a tag no matter what the user clicked. `undefined` (the caller did
    // not fetch assignments) and "no assignments" both flatten to `[]` here, because the wire
    // contract has no third state and a missing array would crash `tagsOfMessage`.
    labels: labels ? [...labels] : [],
    remoteContent: "none",
    updatedAt: m.updatedAt.toISOString(),
  };
}

/**
 * Materialize MANY messages in FOUR queries, whatever the count.
 *
 * The shape that matters is not "faster" but "constant": a page of 500 costs the same number of
 * round-trips as a page of 1, so the sync endpoint's latency stops scaling with the mailbox. A
 * missing id is simply absent from the map, which is the same signal the single-id path gives by
 * returning null, so `SyncService` still emits its tombstone unchanged.
 *
 * THREE became FOUR, and the count is in this sentence because it is the property under
 * test — `materialize-batch.test.ts` counts round-trips, so a future N+1 fails here rather than
 * being discovered on a production bootstrap. The tag lookup is one `inArray` over
 * `message_tags` keyed by the SAME surviving ids as the other two side tables, which is why it
 * costs one query and not one per message.
 *
 * `accountId` is on the `messages` predicate, so an id belonging to another account is filtered
 * before it can be assembled — the batch cannot widen what a caller may see. The three side
 * tables are keyed by the message ids that survived that filter, never by the caller's raw
 * input. `message_tags` additionally carries its own `account_id` and it is ALSO filtered on,
 * belt and braces: that column is denormalized, so a bug that ever let it disagree with the
 * message's owner must fail closed rather than leak one account's tag names to another.
 */
export async function materializeMessages(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, MessageDTO>> {
  const out = new Map<string, MessageDTO>();
  if (ids.length === 0) return out;

  const unique = [...new Set(ids)];
  const rows = await db.select().from(messages)
    .where(and(inArray(messages.id, unique), eq(messages.accountId, accountId)));
  if (rows.length === 0) return out;

  const owned = rows.map((r) => r.id);
  const fsRows = await db.select().from(folderState).where(inArray(folderState.messageId, owned));
  const stRows = await db.select().from(messageStates).where(inArray(messageStates.messageId, owned));
  const mtRows = await db.select().from(messageTags)
    .where(and(inArray(messageTags.messageId, owned), eq(messageTags.accountId, accountId)));

  const fsBy = new Map(fsRows.map((r) => [r.messageId, r]));
  const stBy = new Map(stRows.map((r) => [r.messageId, r]));
  const tagsBy = new Map<string, string[]>();
  for (const r of mtRows) {
    const list = tagsBy.get(r.messageId);
    if (list) list.push(r.tagId);
    else tagsBy.set(r.messageId, [r.tagId]);
  }
  for (const m of rows) {
    out.set(m.id, messageRowToDTO(m, fsBy.get(m.id), stBy.get(m.id), tagsBy.get(m.id)));
  }
  return out;
}

export async function materializeMessage(db: Db, accountId: string, id: string): Promise<MessageDTO | null> {
  return (await materializeMessages(db, accountId, [id])).get(id) ?? null;
}

export async function materializeMessageState(db: Db, accountId: string, id: string): Promise<MessageStateDTO | null> {
  const [st] = await db.select().from(messageStates)
    .where(and(eq(messageStates.id, id), eq(messageStates.accountId, accountId))).limit(1);
  return st ? stateRowToDTO(st) : null;
}

export async function materializeThread(db: Db, accountId: string, id: string): Promise<ThreadDTO | null> {
  const [t] = await db.select().from(threads)
    .where(and(eq(threads.id, id), eq(threads.accountId, accountId))).limit(1);
  if (!t) return null;

  const msgs = await db.select().from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.threadId, id)))
    .orderBy(asc(messages.date));

  let folder: Folder = "INBOX";
  if (msgs[0]) {
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msgs[0].id)).limit(1);
    const loc = (msgs[0].nativeLocator as { folder?: string } | null) ?? null;
    folder = (fs?.desiredFolder ?? loc?.folder ?? "INBOX") as Folder;
  }

  return {
    id: t.id,
    accountId: t.accountId,
    subject: t.subject,
    messageIds: msgs.map((m) => m.id),
    participants: (t.participants as EmailAddress[]) ?? [],
    lastMessageAt: (iso(t.lastMessageAt) ?? t.updatedAt.toISOString()),
    unreadCount: msgs.filter((m) => m.unread).length,
    muted: t.muted,
    folder,
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function materializeRoutingDecision(db: Db, accountId: string, id: string): Promise<RoutingDecisionDTO | null> {
  const [r] = await db.select().from(routingDecisions)
    .where(and(eq(routingDecisions.id, id), eq(routingDecisions.accountId, accountId))).limit(1);
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.accountId,
    messageId: r.messageId,
    inputProvenance: r.inputProvenance as RoutingDecisionDTO["inputProvenance"],
    matchedRuleId: r.matchedRuleId ?? null,
    destination: r.destination as Folder,
    confidence: r.confidence ?? null,
    rationale: r.rationale ?? null,
    spam: r.spam,
    status: r.status as RoutingDecisionDTO["status"],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function materializeApproval(db: Db, accountId: string, id: string): Promise<ApprovalDTO | null> {
  const [a] = await db.select().from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.accountId, accountId))).limit(1);
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind as ApprovalDTO["kind"],
    messageId: a.messageId ?? null,
    proposed: { action: a.action, summary: a.summary, payload: a.payload ?? null },
    routingDecisionId: a.routingDecisionId ?? null,
    confidence: a.confidence ?? null,
    expiresAt: (iso(a.expiresAt) ?? a.createdAt.toISOString()),
    status: a.status as ApprovalDTO["status"],
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function materializeRule(db: Db, accountId: string, id: string): Promise<RuleDTO | null> {
  const [r] = await db.select().from(rules)
    .where(and(eq(rules.id, id), eq(rules.accountId, accountId))).limit(1);
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind as RuleDTO["kind"],
    match: r.match,
    destination: r.destination as Folder,
    priority: r.priority,
    provenance: r.provenance as RuleDTO["provenance"],
    enabled: r.enabled,
    stats: { hits: r.hits, lastHitAt: iso(r.lastHitAt), demotions: r.demotions },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Re-materialize a draft into DraftDTO. MANDATORY: `EntityType` already
 * includes `"draft"`, so without this case a `draft` change_log row would fall
 * through to `default: null` and SyncService would delete-tombstone every live
 * draft. accountId-scoped.
 */
export async function materializeDraft(db: Db, accountId: string, id: string): Promise<DraftDTO | null> {
  const [d] = await db.select().from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.accountId, accountId))).limit(1);
  if (!d) return null;
  return {
    id: d.id,
    mailboxId: d.mailboxId,
    threadId: d.threadId ?? null,
    inReplyToMessageId: d.inReplyToMessageId ?? null,
    subject: d.subject,
    body: d.body,
    html: d.html ?? null,
    to: (d.to as EmailAddress[]) ?? [],
    cc: (d.cc as EmailAddress[]) ?? [],
    bcc: (d.bcc as EmailAddress[]) ?? [],
    rationale: d.rationale ?? null,
    status: d.status as DraftStatus,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * Re-materialize the CURRENT DTO for a `change_log` row's entity. Returns
 * `null` when the live entity is gone → SyncService emits a `delete` tombstone.
 * Unknown/not-yet-implemented entity types return `null` (tombstone) rather than
 * throwing, so an unrecognized change never wedges the feed.
 */
/**
 * One `tags` row → `TagDTO`. Its existence is the precondition for growing
 * `EntityType`: without this case `materialize` would fall through to `null` and `SyncService`
 * would read every tag change as a tombstone, deleting each tag from the client the moment it
 * was created. Added alongside the `"tag"` union member, deliberately.
 *
 * No `className` — see the migration. The client derives it from `hue`.
 */
export async function materializeTag(db: Db, accountId: string, id: string): Promise<TagDTO | null> {
  const [t] = await db.select().from(tags)
    .where(and(eq(tags.id, id), eq(tags.accountId, accountId))).limit(1);
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    hue: t.hue,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function materialize(db: Db, accountId: string, type: EntityType, id: string): Promise<unknown | null> {
  switch (type) {
    case "message": return materializeMessage(db, accountId, id);
    case "tag": return materializeTag(db, accountId, id);
    case "message_state": return materializeMessageState(db, accountId, id);
    case "thread": return materializeThread(db, accountId, id);
    case "routing_decision": return materializeRoutingDecision(db, accountId, id);
    case "approval": return materializeApproval(db, accountId, id);
    case "rule": return materializeRule(db, accountId, id);
    case "draft": return materializeDraft(db, accountId, id);
    default: return Promise.resolve(null);
  }
}
