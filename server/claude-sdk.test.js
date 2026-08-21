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

test('mapCliOptionsToSDK makes normal sessions fully authorized for subagent inheritance', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  for (const permissionMode of [undefined, 'default', 'acceptEdits', 'bypassPermissions']) {
    const options = claudeSdk.mapCliOptionsToSDK({
      permissionMode,
      executionEnv: {},
    });

    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.ok(options.disallowedTools.includes('WebSearch'));
    assert.ok(options.disallowedTools.includes('WebFetch'));
  }
});

test('mapCliOptionsToSDK preserves plan mode without enabling permission bypass', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({
    permissionMode: 'plan',
    executionEnv: {},
  });

  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.ok(options.allowedTools.includes('Read'));
  assert.ok(options.allowedTools.includes('Task'));
});

test('mapCliOptionsToSDK appends managed Agent.md instructions with explicit precedence', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({
    executionEnv: {},
    agentInstructions: '# Role\n\nYou are a market analyst.',
    settingSources: ['project', 'user', 'local'],
  });

  assert.equal(options.systemPrompt.type, 'preset');
  assert.equal(options.systemPrompt.preset, 'claude_code');
  assert.match(options.systemPrompt.append, /Platform-managed Agent configuration/);
  assert.match(options.systemPrompt.append, /conflict.*CLAUDE\.md.*follow Agent\.md/i);
  assert.match(options.systemPrompt.append, /You are a market analyst/);
  assert.deepEqual(options.settingSources, ['project', 'user', 'local']);
});

test('mapCliOptionsToSDK leaves the system prompt unextended without Agent.md content', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({ executionEnv: {}, agentInstructions: '  ' });

  assert.equal(options.systemPrompt.append, undefined);
});

test('createClaudePromptFactory keeps text-only prompts as strings', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const createPrompt = claudeSdk.createClaudePromptFactory('hello', []);

  assert.equal(createPrompt(), 'hello');
});

test('buildClaudeUserMessage keeps display metadata out of model content', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const expandedSkillContent = '# report-skill\n\nExpanded skill instructions.';

  const message = claudeSdk.buildClaudeUserMessage(expandedSkillContent, [], {
    uuid: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(message.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(message.message.content, expandedSkillContent);
  assert.equal(message.message.content.includes('ccui-display-command'), false);
  assert.equal(message.message.content.includes('/report-skill'), false);
});

test('buildClaudeUserMessage preserves native multiline skill invocations exactly', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const invocation = '/report-skill\n第一行\n第二行\n\n```json\n{"sentinel":"FINAL_LINE"}\n```';

  const message = claudeSdk.buildClaudeUserMessage(invocation, []);

  assert.equal(message.message.content, invocation);
});

test('resolveClaudeSupplementPayload validates without trimming native skill content', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const invocation = '/report-skill\n第一行\n第二行\n';

  const payload = claudeSdk.resolveClaudeSupplementPayload({
    sessionId: '  session-1  ',
    content: invocation,
  });

  assert.deepEqual(payload, {
    sessionId: 'session-1',
    content: invocation,
    displayContent: invocation,
    valid: true,
  });
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
