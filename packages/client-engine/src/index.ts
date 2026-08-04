/**
 * @ohmail/client-engine — the delta-first client spine (brief §4), shared by the
 * web app now and mirrored by the native SwiftData port later:
 *
 *   MirrorStore  — IndexedDB (web) / in-memory (SSR, tests) local mirror with
 *                  the idempotent, seq-guarded apply the backend tests prove;
 *   Adapters     — FixturesAdapter (?demo + UI tests) and HttpAdapter (the real
 *                  /sync + mutation protocol) behind ONE interface;
 *   OhmailEngine — bootstrap → drain → apply, optimistic mutation queue
 *                  (user-always-wins), wake-signal hook, instant local search.
 */
export const ENGINE_VERSION = "0.1.0";

// Wire vocabulary + errors.
export {
  CursorExpiredError,
  MutationRejectedError,
  UnsupportedMutationError,
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  folderLeaf,
  encodeSeqCursor,
  decodeSeqCursor,
  type ChangeOp,
  type Cursor,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMessageExtras,
  type EngineMutation,
  type Folder,
  type ISODateTime,
  type OhmailView,
  type BodyState,
  type MessageBody,
  type MessageBodyRecord,
  type MessageBodyWire,
  type MessageStateDTO,
  type MirrorEntityType,
  type RuleDTO,
  type ScreenerHeldMail,
  type ScreenerSegment,
  type ScreenerSenderDTO,
  type SensitivityFlags,
  type SyncChange,
  type SyncEntityType,
  type SyncResponse,
  type TagDTO,
  type TriageItemDTO,
  type TriageState,
  type WaterlineMeta,
} from "./types.js";

// Consent, the dormancy cutline, and History — presentation by who wrote, not by where it sits.
export {
  DEFAULT_DORMANCY_DAYS,
  consentIndex,
  consentPartition,
  decidedDestination,
  domainOfAddress,
  historyView,
  physicalFolderOf,
  presentationReader,
  senderActivity,
  type ConsentCounts,
  type ConsentIndex,
  type ConsentOptions,
  type ConsentPartition,
  type SenderActivity,
} from "./consent-cutline.js";

// Apply core (the convergence oracle) + stores.
export { applyToRecords, flattenResponse, maxSeqOf, recordKey, type MirrorRecord } from "./apply.js";
export { BaseMirrorStore, MemoryMirrorStore, type EntityReader, type MirrorStore } from "./store.js";
export {
  IndexedDbMirrorStore,
  LEGACY_MIRROR_DB,
  MIRROR_DB_PREFIX,
  clearAllMirrors,
  mirrorDbName,
  purgeLegacyMirror,
  type IndexedDbMirrorStoreOptions,
} from "./idb.js";

// Selectors.
export {
  bodyOf,
  messageDisplayTime,
  messagesIn,
  ohboxView,
  readsPartition,
  receiptsByDay,
  rulesList,
  screenerSegments,
  senderKey,
  sendingMailboxId,
  triagePiles,
  tagsCrossView,
  threadOf,
  unreadCounts,
  type EngineCounts,
  type OhboxView,
  type ReadsPartition,
  type ReceiptsDayGroup,
  type ScreenerSegments,
  type TagGroup,
  type TriagePileEntry,
  type TriagePiles,
} from "./selectors.js";

// The address book — every correspondent the mirror knows, for the compose field.
export {
  addressBook,
  formatRecipient,
  isRobotAddress,
  matchAddresses,
  rankOf,
  type AddressBookEntry,
} from "./address-book.js";

// Search.
export { SearchIndex, type LocalSearchResult, type SearchFacets, type SearchHit, type SearchMatch } from "./search.js";

// Mutation semantics (shared optimistic/demo source of truth).
export { mutationEffects, replySubject, type EffectContext, type MutationEffect } from "./mutations.js";

// Adapters.
export type { EngineAdapter, MutationOutcome, SyncParams } from "./adapters/adapter.js";
export { DEMO_NOW, FixturesAdapter, parseFixtureTime, type FixturesAdapterOptions } from "./adapters/fixtures-adapter.js";
export { HttpAdapter, type FetchLike, type HttpAdapterOptions } from "./adapters/http-adapter.js";

// The engine.
export {
  OhmailEngine,
  type EngineOptions,
  type MutationResult,
  type MutationStatus,
  type WakeSignalSource,
} from "./engine.js";
