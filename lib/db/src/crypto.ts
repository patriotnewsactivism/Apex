// ─── Encryption helpers for provider connections ────────────────────────────────
//
// Fernet-style AES-256-GCM encryption for provider credentials.
// Encryption key must be a 32-byte hex string (64 hex chars) or base64 (44 chars).
//
// These helpers are used by the provider_connections migration and tools to encrypt
// credentials at rest. The key is derived from APEX_ENCRYPTION_KEY env var.
//
// NOTE: This is a minimal implementation. For production use with high-sensitivity
// credentials, consider using a dedicated KMS (AWS KMS, GCP KMS, HashiCorp Vault).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 16;

function deriveKey(encryptionKey: string): Buffer {
  // If the key is already 32 bytes (hex or base64), use it directly.
  // Otherwise, derive a 32-byte key using scrypt.
  let raw: Buffer;

  // Try hex first (64 hex chars = 32 bytes)
  if (/^[a-fA-F0-9]{64}$/.test(encryptionKey)) {
    raw = Buffer.from(encryptionKey, 'hex');
  } else if (/^[A-Za-z0-9+/=]{44}$/.test(encryptionKey)) {
    // base64 (44 chars with padding = 32 bytes)
    raw = Buffer.from(encryptionKey, 'base64');
  } else if (encryptionKey.length >= 32) {
    // Use first 32 bytes as raw key
    raw = Buffer.from(encryptionKey.slice(0, 32));
  } else {
    // Derive using scrypt with a fixed salt (not ideal, but works for dev)
    // In production, use a proper key derivation with a stored salt.
    raw = scryptSync(encryptionKey, 'apex-salt', 32);
  }

  if (raw.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes. Got ${raw.length} bytes.`);
  }

  return raw;
}

/**
 * Encrypt a JSON-serializable object.
 * Returns a base64-encoded string containing: salt (if derived) + IV + ciphertext + tag
 */
export async function encrypt(plaintext: Record<string, unknown>, encryptionKey: string): Promise<string> {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const plaintextStr = JSON.stringify(plaintext);
  const plaintextBuf = Buffer.from(plaintextStr, 'utf-8');

  const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv (12) + tag (16) + ciphertext
  const result = Buffer.concat([iv, tag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted payload.
 * Returns the original JSON object.
 */
export async function decrypt(encryptedBase64: string, encryptionKey: string): Promise<Record<string, unknown>> {
  const key = deriveKey(encryptionKey);
  const data = Buffer.from(encryptedBase64, 'base64');

  if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Encrypted payload too short');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

/**
 * Generate a new random encryption key.
 * Returns a 32-byte key as a hex string (64 chars).
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}
