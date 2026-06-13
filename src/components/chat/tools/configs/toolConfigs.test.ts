import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSearchToolResult, TOOL_CONFIGS } from './toolConfigs';

test('normalizeSearchToolResult prefers discovered filenames over a stale zero count', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      toolUseResult: {
        numFiles: '0',
        filenames: ['src/App.tsx', 'src/main.tsx'],
      },
    }),
    {
      count: 2,
      files: ['src/App.tsx', 'src/main.tsx'],
    },
  );
});

test('normalizeSearchToolResult reads filenames from JSON content fallback', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: JSON.stringify({
        filenames: ['server/index.js', 'server/projects.js'],
      }),
    }),
    {
      count: 2,
      files: ['server/index.js', 'server/projects.js'],
    },
  );
});

test('normalizeSearchToolResult reads file lists from plain text content', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: 'Found 2 files\nsrc/components/chat/tools/configs/toolConfigs.ts\nsrc/stores/useSessionStore.ts',
    }),
    {
      count: 2,
      files: [
        'src/components/chat/tools/configs/toolConfigs.ts',
        'src/stores/useSessionStore.ts',
      ],
    },
  );
});

test('normalizeSearchToolResult deduplicates grep line output by file path', () => {
  assert.deepEqual(
    normalizeSearchToolResult({
      content: [
        {
          type: 'text',
          text: 'src/App.tsx:10:Grep\nsrc/App.tsx:20:Glob\nC:\\work\\app\\server.js:5:Grep',
        },
      ],
    }),
    {
      count: 2,
      files: ['src/App.tsx', 'C:\\work\\app\\server.js'],
    },
  );
});

test('Grep result title uses normalized search result count', () => {
  const title = TOOL_CONFIGS.Grep.result?.title;

  assert.equal(
    typeof title === 'function'
      ? title({ toolUseResult: { numFiles: '0', filenames: ['src/App.tsx'] } })
      : title,
    'Found 1 file',
  );
});
