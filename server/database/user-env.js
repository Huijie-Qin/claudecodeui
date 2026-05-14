import crypto from 'node:crypto';

export const USER_KEY_ENV_NAME = 'USER_KEY';
export const USER_KEY_ENCRYPTION_PREFIX = 'security';
export const SECRET_STRING_ENCRYPTION_PREFIX = 'secret';

const USER_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const USER_KEY_ENCRYPTED_PATTERN = /^security:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/i;
const SECRET_STRING_ENCRYPTED_PATTERN = /^secret:[0-9a-f]{24}:[0-9a-f]*:[0-9a-f]{32}$/i;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireSecretMaterial(secretMaterial) {
  const value = String(secretMaterial || '').trim();
  if (!value) {
    throw new Error('USER_KEY encryption key is not configured');
  }
  return value;
}

function decodeBase64Key(value) {
  for (const encoding of ['base64url', 'base64']) {
    try {
      const decoded = Buffer.from(value, encoding);
      if (decoded.length === 32) {
        return decoded;
      }
    } catch {
      // Try the next supported representation.
    }
  }
  return null;
}

export function deriveUserKeyEncryptionKey(secretMaterial) {
  const value = requireSecretMaterial(secretMaterial);
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const base64Key = decodeBase64Key(value);
  if (base64Key) {
    return base64Key;
  }

  const utf8Key = Buffer.from(value, 'utf8');
  if (utf8Key.length === 32) {
    return utf8Key;
  }

  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function toHex(buffer) {
  return Buffer.from(buffer).toString('hex').toUpperCase();
}

function fromHex(value, name) {
  const normalized = String(value || '').trim();
  if (!/^[0-9a-f]*$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${name} must be a hex string`);
  }
  return Buffer.from(normalized, 'hex');
}

export function generateUserKey() {
  return crypto.randomBytes(32).toString('hex').toUpperCase();
}

export function isRawUserKey(value) {
  return USER_KEY_HEX_PATTERN.test(String(value || '').trim());
}

export function isEncryptedUserKey(value) {
  return USER_KEY_ENCRYPTED_PATTERN.test(String(value || '').trim());
}

export function isEncryptedSecretString(value) {
  return SECRET_STRING_ENCRYPTED_PATTERN.test(String(value || '').trim());
}

export function encryptUserKey(userKey, { secretMaterial, iv = null } = {}) {
  const plaintext = String(userKey || '').trim().toUpperCase();
  if (!isRawUserKey(plaintext)) {
    throw new Error('USER_KEY must be a 64-character hex string');
  }

  const nonce = iv ? Buffer.from(iv) : crypto.randomBytes(12);
  if (nonce.length !== 12) {
    throw new Error('USER_KEY AES-GCM nonce must be 12 bytes');
  }

  const cipher = crypto.createCipheriv('aes-256-gcm', deriveUserKeyEncryptionKey(secretMaterial), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    USER_KEY_ENCRYPTION_PREFIX,
    toHex(nonce),
    toHex(ciphertext),
    toHex(tag),
  ].join(':');
}

export function decryptUserKey(value, { secretMaterial } = {}) {
  const encrypted = String(value || '').trim();
  if (!isEncryptedUserKey(encrypted)) {
    throw new Error('Encrypted USER_KEY is malformed');
  }

  const [, nonceHex, ciphertextHex, tagHex] = encrypted.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveUserKeyEncryptionKey(secretMaterial),
    fromHex(nonceHex, 'nonce'),
  );
  decipher.setAuthTag(fromHex(tagHex, 'tag'));
  return Buffer.concat([
    decipher.update(fromHex(ciphertextHex, 'ciphertext')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptSecretString(value, { secretMaterial, iv = null } = {}) {
  const plaintext = String(value ?? '');
  const nonce = iv ? Buffer.from(iv) : crypto.randomBytes(12);
  if (nonce.length !== 12) {
    throw new Error('Secret AES-GCM nonce must be 12 bytes');
  }

  const cipher = crypto.createCipheriv('aes-256-gcm', deriveUserKeyEncryptionKey(secretMaterial), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    SECRET_STRING_ENCRYPTION_PREFIX,
    toHex(nonce),
    toHex(ciphertext),
    toHex(tag),
  ].join(':');
}

export function decryptSecretString(value, { secretMaterial } = {}) {
  const encrypted = String(value || '').trim();
  if (!isEncryptedSecretString(encrypted)) {
    throw new Error('Encrypted secret is malformed');
  }

  const [, nonceHex, ciphertextHex, tagHex] = encrypted.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveUserKeyEncryptionKey(secretMaterial),
    fromHex(nonceHex, 'nonce'),
  );
  decipher.setAuthTag(fromHex(tagHex, 'tag'));
  return Buffer.concat([
    decipher.update(fromHex(ciphertextHex, 'ciphertext')),
    decipher.final(),
  ]).toString('utf8');
}

export function normalizeUserEnvRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => ENV_NAME_PATTERN.test(String(key)) && entry != null)
      .map(([key, entry]) => [String(key), String(entry)]),
  );
}

export function parseUserEnvJson(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeUserEnvRecord(value);
  }

  try {
    return normalizeUserEnvRecord(JSON.parse(String(value)));
  } catch {
    return {};
  }
}

export function ensureUserKeyEnvRecord(value, { secretMaterial } = {}) {
  const env = normalizeUserEnvRecord(value);
  const existing = env[USER_KEY_ENV_NAME];

  if (isEncryptedUserKey(existing)) {
    return env;
  }

  const rawUserKey = isRawUserKey(existing) ? existing : generateUserKey();
  return {
    ...env,
    [USER_KEY_ENV_NAME]: encryptUserKey(rawUserKey, { secretMaterial }),
  };
}

export function decryptUserEnvRecord(value, { secretMaterial } = {}) {
  const env = normalizeUserEnvRecord(value);
  const userKey = env[USER_KEY_ENV_NAME];

  if (!isEncryptedUserKey(userKey)) {
    return env;
  }

  return {
    ...env,
    [USER_KEY_ENV_NAME]: decryptUserKey(userKey, { secretMaterial }),
  };
}

export function serializeUserEnvRecord(value) {
  return JSON.stringify(normalizeUserEnvRecord(value));
}
