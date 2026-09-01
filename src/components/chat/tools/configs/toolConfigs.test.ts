import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSearchToolResult, shouldHideToolResult, TOOL_CONFIGS } from './toolConfigs';

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

test('Bash command and output use collapsed standard tool displays', () => {
  assert.equal(TOOL_CONFIGS.Bash.input.type, 'collapsible');
  assert.equal(TOOL_CONFIGS.Bash.input.title, 'Command');
  assert.equal(TOOL_CONFIGS.Bash.input.defaultOpen, false);
  assert.equal(TOOL_CONFIGS.Bash.input.stickyHeader, false);
  assert.deepEqual(
    TOOL_CONFIGS.Bash.input.getContentProps?.({ command: 'npm run build' }),
    {
      content: 'npm run build',
      format: 'code',
    },
  );

  assert.equal(TOOL_CONFIGS.Bash.result?.type, 'collapsible');
  assert.equal(TOOL_CONFIGS.Bash.result?.title, 'Output');
  assert.equal(TOOL_CONFIGS.Bash.result?.defaultOpen, false);
  assert.equal(TOOL_CONFIGS.Bash.result?.stickyHeader, false);

  const getContentProps = TOOL_CONFIGS.Bash.result?.getContentProps;
  assert.deepEqual(
    getContentProps?.({
      content: 'duplicate stdout',
      toolUseResult: {
        stdout: '\u001b[32mnormal stdout\u001b[0m\n',
        stderr: 'normal stderr\n',
      },
    }),
    {
      content: 'normal stdout\nnormal stderr',
      format: 'code',
    },
  );

  assert.equal(shouldHideToolResult('Bash', { content: '' }), true);
  assert.equal(shouldHideToolResult('Bash', { content: 'output' }), false);
});
