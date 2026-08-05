import {
  randomBytes, scrypt as _scrypt, timingSafeEqual, createHash,
} from "node:crypto";
import { promisify } from "node:util";

// The envelope-encryption primitive (KeyProvider) now lives in @trafficflow/core
// so the worker can decrypt `mailbox_credentials` without importing services.
// Re-exported here UNCHANGED so every existing auth import (config/types/index) and
// the existing tests keep resolving `KeyProvider`/`StaticKeyProvider` from this module.
export { type KeyProvider, StaticKeyProvider } from "@trafficflow/core/mail";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
) => Promise<Buffer>;

// ─────────────────────────────────────────────────────────────────────────────
// Password hashing — scrypt via node:crypto. NOT native argon2.
// Stored form: "scrypt$<keylen>$<saltB64url>$<hashB64url>".
// ─────────────────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Constant-time verify. MUST run its full cost even when `stored` is a decoy
   *  (unknown-email path) so login timing does not leak account existence. */
  verify(password: string, stored: string): Promise<boolean>;
}

export const scryptHasher: PasswordHasher = {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
    return `scrypt$${SCRYPT_KEYLEN}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  },

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") {
      // Still burn a scrypt to keep timing uniform, then fail.
      await scrypt(password, "decoy-salt", SCRYPT_KEYLEN);
      return false;
    }
    const keylen = Number(parts[1]);
    const salt = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(parts[3]!, "base64url");
    const derived = await scrypt(password, salt, keylen);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Opaque-token generation + hash-at-rest. Session/refresh/login/OAuth/recovery
// tokens are random secrets; only their SHA-256 hash is persisted, and lookups
// hash the presented token before comparing.
// ─────────────────────────────────────────────────────────────────────────────

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}
