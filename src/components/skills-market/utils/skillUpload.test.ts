import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SKILL_UPLOAD_SINGLE_FILE_ERROR,
  SKILL_UPLOAD_ZIP_ONLY_ERROR,
  selectSkillUploadArchive,
} from './skillUpload';

type TestFile = {
  name: string;
  type: string;
};

test('selectSkillUploadArchive accepts one ZIP by extension', () => {
  const archive: TestFile = { name: 'my-skill.zip', type: '' };
  assert.deepEqual(selectSkillUploadArchive([archive]), { file: archive, error: null });
});

test('selectSkillUploadArchive accepts ZIP MIME types and uppercase extensions', () => {
  const mimeArchive: TestFile = { name: 'skill-archive', type: 'application/zip' };
  const uppercaseArchive: TestFile = { name: 'SKILL.ZIP', type: 'application/octet-stream' };

  assert.deepEqual(selectSkillUploadArchive([mimeArchive]), { file: mimeArchive, error: null });
  assert.deepEqual(selectSkillUploadArchive([uppercaseArchive]), { file: uppercaseArchive, error: null });
});

test('selectSkillUploadArchive rejects a non-ZIP file', () => {
  assert.deepEqual(
    selectSkillUploadArchive<TestFile>([{ name: 'SKILL.md', type: 'text/markdown' }]),
    { file: null, error: SKILL_UPLOAD_ZIP_ONLY_ERROR },
  );
});

test('selectSkillUploadArchive rejects multiple files', () => {
  assert.deepEqual(
    selectSkillUploadArchive<TestFile>([
      { name: 'first.zip', type: 'application/zip' },
      { name: 'second.zip', type: 'application/zip' },
    ]),
    { file: null, error: SKILL_UPLOAD_SINGLE_FILE_ERROR },
  );
});

test('selectSkillUploadArchive ignores an empty selection', () => {
  assert.deepEqual(selectSkillUploadArchive<TestFile>([]), { file: null, error: null });
  assert.deepEqual(selectSkillUploadArchive<TestFile>(null), { file: null, error: null });
});
