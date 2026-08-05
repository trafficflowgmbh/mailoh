/**
 * The ohmail Cloud API client, absent.
 *
 * GENERATED at publish time from the real module's export surface — never edited by hand, so it
 * cannot drift from what it stands in for. The type declarations below are copied verbatim; every
 * value export is the same refusal, so no endpoint path, header or token handling is published.
 *
 * The desktop tier has no Cloud account and no server: it talks to a local engine over a pipe.
 * Reaching for anything here throws rather than quietly opening a socket.
 */

const UNAVAILABLE = "the ohmail Cloud API is not part of this build — the desktop tier talks to its own local engine";

const refuse = (): never => {
  throw new Error(UNAVAILABLE);
};

/* One stand-in for every value export: calling it, constructing it, or reading any property off
 * it refuses. `any` so that consumers of the real module still typecheck against these names. */
const absent: any = new Proxy(function () { refuse(); } as any, {
  get: (_t, key) => (key === "then" ? undefined : absent),
  apply: () => refuse(),
  construct: () => refuse(),
});

export interface SessionUser {
  userId: string;
  accountId: string;
  email: string;
  displayName: string;
  twofaEnrolled: { webauthn: boolean; totp: boolean; recoveryCodes: boolean };
  emailVerified: boolean;
}

export interface EnrollmentSession {
  status: "enrollment";
  user: SessionUser;
  next: "enroll_2fa";
  enrollmentToken: string;
  expiresIn: number;
}

export interface RegistrationPending {
  status: "ok";
}

export interface TwofaChallenge {
  status: "twofa_required";
  loginToken: string;
  methods: Array<"webauthn" | "totp" | "recovery_code">;
}

export type LoginResult = EnrollmentSession | TwofaChallenge;

export interface AuthenticatedSession {
  status: "authenticated";
  user: SessionUser;
}

export interface MailboxDTO {
  id: string;
  provider: string;
  address: string;
  displayName: string | null;
  status: string;
  lastSyncAt: string | null;
  errorCode?: "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown" | null;
  errorDetail?: string | null;
  failedAt?: string | null;
  retryCount?: number;
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  disabledReason?: string | null;
  createdAt?: string;
  initialImportCompletedAt?: string | null;
}

export interface SubscriptionStatus {
  subscription: {
    plan: "solo" | "plus" | "pro";
    status: string;
    mailboxLimit: number;
    monthlyCredits: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
  } | null;
  balance: number;
  entitlements: {
    mailboxLimit: number;
    canAddMailbox: boolean;
    aiEnabled: boolean;
    syncEnabled: boolean;
    reason: string;
  };
  plans: Record<string, { priceUsd: number; mailboxes: number; monthlyCredits: number }>;
}

export interface CreateMailboxBody {
  provider: string;
  address: string;
  displayName?: string;
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
}

export interface ErasureResult {
  erased: true;
  usersErased: number;
  tables: Record<string, number>;
  retained: string;
  subscription: "none" | "cancelled" | "cancel_failed";
}

export interface ConsentStateWire {
  seedConfirmedAt: string | null;
  screeningResetAt: string | null;
  dormancyDays: number;
  counts: {
    decidedSenders: number;
    activeUndecidedSenders: number;
    dormantUndecidedSenders: number;
  };
}

export interface SeedCandidateWire {
  address: string;
  name: string | null;
  messages: number;
  lastWrittenAt: string | null;
  alreadyDecided: boolean;
}

export interface SeedReviewWire {
  candidates: SeedCandidateWire[];
  excluded: Array<{ address: string; reason: "robot-recipient" | "machine-sent" | "own-address" }>;
  scannedMessages: number;
  truncated: boolean;
}

export interface ScreenerWireItem {
  id: string;
  messageId: string;
  sender: { name: string | null; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  aiSuggestion: { decision: "yes" | "no"; confidence: number; rationale: string } | null;
}

export interface ScreenerWirePage {
  items: ScreenerWireItem[];
  nextCursor: string | null;
  suggestable: { senders: string[]; credits: number; maxPerRequest: number };
}

export type ScreenerSkipReason =
  | "not_held" | "withheld" | "out_of_credits" | "spend_unavailable" | "model_unavailable";

export interface ScreenerSuggestWire {
  dryRun: boolean;
  requested: number;
  quoted: number;
  quotedCredits: number;
  charged: number;
  stopped?: "out_of_credits" | "spend_unavailable";
  suggestions: Array<{
    sender: string;
    messageId: string;
    decision: "yes" | "no";
    confidence: number;
    rationale: string;
  }>;
  skipped: Array<{ sender: string; reason: ScreenerSkipReason }>;
}

export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  userVerification?: string;
}

export const API_BASE: any = absent;
export const ApiError: any = absent;
export const OFFLINE_CODE = "network_unreachable";
export const account: any = absent;
export const aiSettings: any = absent;
export const api: any = absent;
export const apiConfigured: any = absent;
export const assertPasskey: any = absent;
export const auth: any = absent;
export const billing: any = absent;
export const codeOf: any = absent;
export const consent: any = absent;
export const createPasskey: any = absent;
export const csrfToken: any = absent;
export const mailboxes: any = absent;
export const messageOf: any = absent;
export const privacy: any = absent;
export const screener: any = absent;
export const webauthnAvailable: any = absent;
