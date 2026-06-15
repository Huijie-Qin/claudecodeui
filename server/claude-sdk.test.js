import assert from 'node:assert/strict';
import test from 'node:test';

const withEnv = (key, value, callback) => {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
};

test('resolveClaudeModel lets ANTHROPIC_MODEL override UI model aliases', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.equal(typeof claudeSdk.resolveClaudeModel, 'function');
  withEnv('ANTHROPIC_MODEL', 'glm-5.1', () => {
    assert.equal(claudeSdk.resolveClaudeModel({ model: 'opus' }), 'glm-5.1');
  });
});

test('resolveClaudeModel falls back to the UI model when no environment override is configured', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  withEnv('ANTHROPIC_MODEL', undefined, () => {
    assert.equal(claudeSdk.resolveClaudeModel({ model: 'sonnet' }), 'sonnet');
  });
});

test('createClaudePromptFactory keeps text-only prompts as strings', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const createPrompt = claudeSdk.createClaudePromptFactory('hello', []);

  assert.equal(createPrompt(), 'hello');
});

test('createClaudePromptFactory creates native image content blocks', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const createPrompt = claudeSdk.createClaudePromptFactory('describe this', [
    {
      data: 'data:image/png;base64,aGVsbG8=',
      size: 5,
      mimeType: 'image/png',
    },
  ]);

  const iterator = createPrompt()[Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = await iterator.next();

  assert.equal(second.done, true);
  assert.equal(first.value.type, 'user');
  assert.equal(first.value.parent_tool_use_id, null);
  assert.deepEqual(first.value.message, {
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    ],
  });
});

test('createClaudePromptFactory rejects unsupported image types', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.throws(
    () => claudeSdk.createClaudePromptFactory('describe this', [
      {
        data: 'data:image/svg+xml;base64,PHN2Zy8+',
        size: 6,
        mimeType: 'image/svg+xml',
      },
    ]),
    /Unsupported image type image\/svg\+xml/,
  );
});
