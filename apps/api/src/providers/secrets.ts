import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Provider secret storage (C6.3).
 *
 * Provider API keys are application secrets. They are never stored in
 * plaintext in the database and are never returned by any API response.
 * This module is the single server-side abstraction that seals and reveals
 * them.
 *
 * Scheme: AES-256-GCM (authenticated encryption). The 32-byte key is derived
 * from the `APP_ENCRYPTION_KEY` environment variable with scrypt, so the key
 * itself is never held in configuration. The on-disk envelope is
 *
 *     icooro-v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>
 *
 * (the prefix deliberately contains no ":" so the envelope always splits
 * into exactly four fields). GCM's auth tag makes tampering detectable, and
 * the per-envelope IV means sealing the same key twice never yields the
 * same ciphertext.
 *
 * PRODUCTION REQUIREMENT (see docs/provider-secrets.md):
 *   `APP_ENCRYPTION_KEY` MUST be set to a high-entropy value (>= 32 random
 *   bytes, e.g. 64 hex chars) provisioned from your secret manager / KMS.
 *   Sealing or revealing a key without it throws. Rotating the value
 *   requires re-sealing every provider key.
 */


const ENVELOPE_PREFIX = "icooro-v1";
const CIPHER = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_LENGTH = 32;
// Fixed app-level salt. The strength of scrypt with a high-entropy
// APP_ENCRYPTION_KEY is what protects the key material; the salt only
// separates this derivation from other consumers of the same passphrase.
const SALT = "icooro:provider-secrets:v1";

export interface ProviderSecretStore {
  /** Seals a plaintext API key into a storage envelope. */
  seal(plaintext: string): string;
  /** Reveals the plaintext API key from a storage envelope. */
  reveal(envelope: string): string;
}

let cachedKey: Buffer | null = null;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Derives (once, then cached) the 32-byte AES key from
 * `APP_ENCRYPTION_KEY`.
 *
 * In production a missing key is a hard failure: sealing or revealing a
 * provider secret must not silently fall back to a weak key. Outside
 * production (local dev / test) a deterministic throwaway key is derived and
 * a warning is logged so the Control Plane is usable before a real key is
 * provisioned.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const supplied = process.env.APP_ENCRYPTION_KEY ?? "";
  if (supplied.trim() === "") {
    if (isProduction()) {
      throw new Error(
        "APP_ENCRYPTION_KEY is not configured: cannot seal or reveal provider API keys. Provision a high-entropy key (see docs/provider-secrets.md).",
      );
    }
    console.warn(
      "[providers/secrets] APP_ENCRYPTION_KEY is not set — using a deterministic development key. Set a high-entropy value before running in production (see docs/provider-secrets.md).",
    );
    cachedKey = scryptSync("icooro-dev-provider-key", SALT, KEY_LENGTH);
    return cachedKey;
  }

  cachedKey = scryptSync(supplied, SALT, KEY_LENGTH);
  return cachedKey;
}

function toBase64(buf: Buffer): string {
  return buf.toString("base64");
}

function fromBase64(str: string): Buffer {
  return Buffer.from(str, "base64");
}

class AesGcmProviderSecretStore implements ProviderSecretStore {
  seal(plaintext: string): string {
    if (typeof plaintext !== "string" || plaintext === "") {
      throw new Error("Cannot seal an empty provider secret");
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(CIPHER, getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [ENVELOPE_PREFIX, toBase64(iv), toBase64(authTag), toBase64(ciphertext)].join(":");
  }

  reveal(envelope: string): string {
    if (typeof envelope !== "string" || envelope === "") {
      throw new Error("Invalid provider secret envelope");
    }
    const parts = envelope.split(":");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
      throw new Error("Unrecognized provider secret envelope format");
    }
    const [, ivB64, tagB64, ctB64] = parts;
    if (!ivB64 || !tagB64 || !ctB64) {
      throw new Error("Incomplete provider secret envelope");
    }
    try {
      const decipher = createDecipheriv(CIPHER, getKey(), fromBase64(ivB64));
      decipher.setAuthTag(fromBase64(tagB64));
      const plaintext = Buffer.concat([decipher.update(fromBase64(ctB64)), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // Never surface decryption detail; the key may be wrong or the row
      // may have been tampered with. Both are operator incidents.
      throw new Error("Provider secret could not be unsealed (invalid key or tampered envelope)");
    }
  }
}

export const providerSecretStore: ProviderSecretStore = new AesGcmProviderSecretStore();

/**
 * Masked, non-sensitive preview of a sealed key for Admin UI display, e.g.
 * "sk_•••••••1234". Reveals at most the first two and last four characters,
 * and never the full key.
 */
export function maskSecret(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  let plaintext: string;
  try {
    plaintext = providerSecretStore.reveal(envelope);
  } catch {
    // Keep the secret's existence visible without revealing anything.
    return "••••••••";
  }
  if (plaintext.length <= 6) {
    return "••••••••";
  }
  const head = plaintext.slice(0, 2);
  const tail = plaintext.slice(-4);
  return `${head}•••••••${tail}`;
}

/** True when a sealed API key envelope is present. */
export function hasSecret(envelope: string | null | undefined): boolean {
  return typeof envelope === "string" && envelope.trim() !== "";
}
