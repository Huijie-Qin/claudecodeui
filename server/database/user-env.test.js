import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptUserKey,
  encryptUserKey,
  ensureUserKeyEnvRecord,
  isEncryptedUserKey,
  parseUserEnvJson,
  serializeUserEnvRecord,
  USER_KEY_ENV_NAME,
} from './user-env.js';

const TEST_SECRET_HEX = '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F';
const TEST_USER_KEY = '63ACE5B1DC0B2FEBFBEFDC662DD9810FCC9C747BCF6A2D580EB23C1630B8FA18';

test('USER_KEY encryption emits CryptAesGcm-compatible security payloads', () => {
  const encrypted = encryptUserKey(TEST_USER_KEY, {
    secretMaterial: TEST_SECRET_HEX,
    iv: Buffer.from('FFAE9DB481D5D04BAFB3D5D7', 'hex'),
  });

  assert.match(encrypted, /^security:[A-F0-9]{24}:[A-F0-9]{128}:[A-F0-9]{32}$/);
  assert.equal(encrypted.split(':')[1], 'FFAE9DB481D5D04BAFB3D5D7');
  assert.equal(decryptUserKey(encrypted, { secretMaterial: TEST_SECRET_HEX }), TEST_USER_KEY);
});

test('user env records receive an encrypted USER_KEY and keep valid env values', () => {
  const env = ensureUserKeyEnvRecord(
    {
      EXISTING_FLAG: 'enabled',
      'BAD-NAME': 'ignored',
    },
    { secretMaterial: TEST_SECRET_HEX },
  );

  assert.equal(env.EXISTING_FLAG, 'enabled');
  assert.equal(Object.hasOwn(env, 'BAD-NAME'), false);
  assert.equal(isEncryptedUserKey(env[USER_KEY_ENV_NAME]), true);
  assert.equal(parseUserEnvJson(serializeUserEnvRecord(env))[USER_KEY_ENV_NAME], env[USER_KEY_ENV_NAME]);
});

test('raw USER_KEY values are encrypted when normalizing existing env json', () => {
  const env = ensureUserKeyEnvRecord(
    parseUserEnvJson(JSON.stringify({ [USER_KEY_ENV_NAME]: TEST_USER_KEY })),
    { secretMaterial: TEST_SECRET_HEX },
  );

  assert.equal(isEncryptedUserKey(env[USER_KEY_ENV_NAME]), true);
  assert.equal(decryptUserKey(env[USER_KEY_ENV_NAME], { secretMaterial: TEST_SECRET_HEX }), TEST_USER_KEY);
});
