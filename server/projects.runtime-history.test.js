import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteSessionFromProjectsRoot,
  getSessionMessagesFromProjectsRoot,
} from './projects.js';

async function writeJsonl(filePath, rows, trailing = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${trailing}`, 'utf8');
}

test('runtime Claude history finds the session JSONL and ignores other sessions and an incomplete tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-1';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    { sessionId, uuid: 'm2', type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'two' } },
    { sessionId: 'other-session', uuid: 'other', type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'ignore' } },
    { sessionId, uuid: 'm1', type: 'user', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'one' } },
  ], '{"sessionId":"session-1"');

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((message) => message.uuid), ['m1', 'm2']);
});

test('runtime Claude history reads only the directly named transcript when it exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-direct-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-direct';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [{
    sessionId,
    uuid: 'direct-message',
    type: 'user',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: 'direct' },
  }]);
  await writeJsonl(path.join(projectDir, 'unrelated.jsonl'), [{
    sessionId,
    uuid: 'must-not-be-read',
    type: 'assistant',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: 'legacy duplicate' },
  }]);

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.deepEqual(result.messages.map((message) => message.uuid), ['direct-message']);
});

test('runtime Claude history scans legacy transcript names only when the direct file is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-legacy-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-legacy';
  await writeJsonl(path.join(projectDir, 'legacy-layout.jsonl'), [{
    sessionId,
    uuid: 'legacy-message',
    type: 'user',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: 'legacy' },
  }]);

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.deepEqual(result.messages.map((message) => message.uuid), ['legacy-message']);
});

test('runtime Claude history keeps newest-first pagination semantics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-page-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-page';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [1, 2, 3].map((sequence) => ({
    sessionId,
    uuid: `m${sequence}`,
    type: 'assistant',
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    message: { role: 'assistant', content: String(sequence) },
  })));

  const recent = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, 2, 0);
  const older = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, 2, 2);

  assert.deepEqual(recent.messages.map((message) => message.uuid), ['m2', 'm3']);
  assert.equal(recent.hasMore, true);
  assert.deepEqual(older.messages.map((message) => message.uuid), ['m1']);
  assert.equal(older.hasMore, false);
});

test('runtime Claude history keeps the correct page after bounded large-history trimming', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-large-page-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-large-page';
  const rows = Array.from({ length: 600 }, (_, index) => ({
    sessionId,
    uuid: `m${index}`,
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    message: { role: 'assistant', content: String(index) },
  })).reverse();
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), rows);

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, 3, 2);

  assert.equal(result.total, 600);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.messages.map((message) => message.uuid), ['m595', 'm596', 'm597']);
});

test('runtime Claude history restores tools from the current nested subagent transcript layout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-subagent-history-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-subagent';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    {
      sessionId,
      uuid: 'agent-use',
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_agent_1',
          name: 'Agent',
          input: { description: 'Inspect history' },
        }],
      },
    },
    {
      sessionId,
      uuid: 'agent-result',
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      tool_use_result: { status: 'async_launched', agentId: 'agent-1' },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_agent_1',
          content: 'Agent launched.',
        }],
      },
    },
  ]);
  await writeJsonl(
    path.join(projectDir, sessionId, 'subagents', 'agent-agent-1.jsonl'),
    [
      {
        timestamp: '2026-01-01T00:00:01.100Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Inspecting the authentication flow.' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:01.200Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'Read',
            input: { file_path: '/workspace/auth.ts' },
          }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:01.300Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            content: 'source',
          }],
        },
      },
    ],
  );

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
  const agentResult = result.messages.find((message) => message.uuid === 'agent-result');

  assert.deepEqual(agentResult?.subagentTools, [{
    toolId: 'toolu_read_1',
    toolName: 'Read',
    toolInput: { file_path: '/workspace/auth.ts' },
    timestamp: '2026-01-01T00:00:01.200Z',
    toolResult: { content: 'source', isError: false },
  }]);
  assert.equal(agentResult?.subagentMessages?.length, 3);
  assert.equal(agentResult?.subagentMessages?.[0]?.message?.content?.[0]?.text, 'Inspecting the authentication flow.');
});

test('runtime Claude history restores two active child tools before a parent result and keeps completed history compatible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-active-subagent-history-'));
  const projectsRoot = path.join(root, 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-active-child';
  const subagentsDir = path.join(projectDir, sessionId, 'subagents');
  const parent = {
    sessionId, uuid: 'parent-agent-use', type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'parent-agent', name: 'Agent', input: {} }] },
  };
  const childRows = [
    { sessionId, agentId: 'child-a', type: 'assistant', uuid: 'child-submit', timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'submit', name: 'mcp__tasks__execute_task', input: {} }] } },
    { sessionId, agentId: 'child-a', type: 'user', uuid: 'child-submitted', timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'submit', content: '{"task_id":"task-a","status":"running"}' }] } },
    { sessionId, agentId: 'child-a', type: 'assistant', uuid: 'child-status', timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'status', name: 'mcp__tasks__get_task_status', input: { task_id: 'task-a' } }] } },
  ];
  try {
    await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [parent]);
    await writeJsonl(path.join(subagentsDir, 'agent-child-a.jsonl'), [
      ...childRows,
      { ...childRows[0], sessionId: 'other-session', uuid: 'foreign-session' },
      { ...childRows[0], agentId: 'other-agent', uuid: 'foreign-agent' },
    ]);
    await fs.writeFile(path.join(subagentsDir, 'agent-child-a.meta.json'), JSON.stringify({ toolUseId: 'parent-agent' }));
    const active = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
    assert.equal(active.total, 1, 'Restoration must not invent a parent result or alter pagination');
    const restored = active.messages[0].subagentInvocations['parent-agent'];
    assert.equal(restored.agentId, 'child-a');
    assert.deepEqual(restored.subagentTools.map(({ toolId }) => toolId), ['submit', 'status']);
    assert.equal(restored.subagentTools[0].toolResult.content, '{"task_id":"task-a","status":"running"}');
    assert.equal(restored.subagentTools[1].toolResult, undefined, 'The waiting status call remains pending');
    assert.deepEqual(restored.subagentMessages, childRows);
    assert.equal(active.messages[0].toolUseResult, undefined);

    await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [parent, {
      sessionId, uuid: 'parent-result', type: 'user', timestamp: '2026-01-01T00:20:00.000Z',
      toolUseResult: { agentId: 'child-a', status: 'completed' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'parent-agent', content: 'Completed' }] },
    }]);
    const completed = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
    assert.equal(completed.messages[0].subagentInvocations, undefined);
    assert.deepEqual(completed.messages[1].subagentTools.map(({ toolId }) => toolId), ['submit', 'status']);
    assert.deepEqual(completed.messages[1].subagentMessages, childRows);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('active subagent metadata keeps parallel Agents in one assistant message separate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-parallel-active-history-'));
  const projectsRoot = path.join(root, 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-parallel';
  const subagentsDir = path.join(projectDir, sessionId, 'subagents');
  try {
    await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [{
      sessionId, uuid: 'parallel-use', type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: ['a', 'b'].map((key) => ({ type: 'tool_use', id: `parent-${key}`, name: 'Agent', input: {} })) },
    }]);
    for (const key of ['a', 'b']) {
      await writeJsonl(path.join(subagentsDir, `agent-child-${key}.jsonl`), [{
        sessionId, agentId: `child-${key}`, uuid: `use-${key}`, type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `status-${key}`, name: 'mcp__tasks__get_task_status', input: { task_id: `task-${key}` } }] },
      }]);
      await fs.writeFile(path.join(subagentsDir, `agent-child-${key}.meta.json`), JSON.stringify({ toolUseId: `parent-${key}` }));
    }
    const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
    const invocations = result.messages[0].subagentInvocations;
    assert.deepEqual(Object.keys(invocations).sort(), ['parent-a', 'parent-b']);
    for (const key of ['a', 'b']) {
      assert.equal(invocations[`parent-${key}`].agentId, `child-${key}`);
      assert.deepEqual(invocations[`parent-${key}`].subagentTools.map(({ toolId }) => toolId), [`status-${key}`]);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('active subagent restoration ignores malformed, ambiguous, unrelated and symlink metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-active-history-safety-'));
  const projectsRoot = path.join(root, 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-safe';
  const subagentsDir = path.join(projectDir, sessionId, 'subagents');
  try {
    await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [{
      sessionId, uuid: 'uses', type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [
        ...['ambiguous', 'linked', 'malformed'].map((id) => ({ type: 'tool_use', id, name: 'Agent', input: {} })),
        { type: 'tool_use', id: 'ordinary', name: 'Bash', input: {} },
      ] },
    }]);
    for (const [agentId, toolUseId] of [['a', 'ambiguous'], ['b', 'ambiguous'], ['orphan', 'missing'], ['ordinary', 'ordinary'], ['linked', 'linked'], ['bad', 'malformed']]) {
      await writeJsonl(path.join(subagentsDir, `agent-${agentId}.jsonl`), [{
        sessionId, agentId, uuid: `use-${agentId}`, type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `status-${agentId}`, name: 'mcp__tasks__get_task_status', input: {} }] },
      }]);
      const metadataPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
      if (agentId === 'linked') {
        const outsideMetadata = path.join(root, 'outside.json');
        await fs.writeFile(outsideMetadata, JSON.stringify({ toolUseId }));
        await fs.symlink(outsideMetadata, metadataPath);
      } else {
        await fs.writeFile(metadataPath, agentId === 'bad' ? '{"toolUseId":' : JSON.stringify({ toolUseId }));
      }
    }
    const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
    assert.equal(result.messages[0].subagentInvocations, undefined);
    assert.equal(result.messages[0].subagentTools, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime Claude history keeps resumed agent generations separated by parent tool id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-resumed-agent-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-resumed-agent';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    {
      sessionId,
      uuid: 'agent-use-1',
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: { description: 'First pass' },
      }] },
    },
    {
      sessionId,
      uuid: 'agent-result-1',
      type: 'user',
      timestamp: '2026-01-01T00:00:01.100Z',
      toolUseResult: { status: 'async_launched', agentId: 'agent-shared' },
      message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'First launch.',
      }] },
    },
    {
      sessionId,
      uuid: 'agent-use-2',
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'toolu_agent_2', name: 'Agent', input: { resume: 'agent-shared' },
      }] },
    },
    {
      sessionId,
      uuid: 'agent-result-2',
      type: 'user',
      timestamp: '2026-01-01T00:00:02.100Z',
      toolUseResult: { status: 'async_launched', agentId: 'agent-shared' },
      message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_agent_2', content: 'Second launch.',
      }] },
    },
  ]);
  await writeJsonl(
    path.join(projectDir, sessionId, 'subagents', 'agent-agent-shared.jsonl'),
    [
      {
        timestamp: '2026-01-01T00:00:01.200Z',
        parent_tool_use_id: 'toolu_agent_1',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: '/workspace/first.ts' },
        }] },
      },
      {
        timestamp: '2026-01-01T00:00:02.200Z',
        parent_tool_use_id: 'toolu_agent_2',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_read_2', name: 'Read', input: { file_path: '/workspace/second.ts' },
        }] },
      },
    ],
  );

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
  const firstResult = result.messages.find((message) => message.uuid === 'agent-result-1');
  const secondResult = result.messages.find((message) => message.uuid === 'agent-result-2');

  assert.deepEqual(firstResult?.subagentTools?.map((tool) => tool.toolId), ['toolu_read_1']);
  assert.deepEqual(secondResult?.subagentTools?.map((tool) => tool.toolId), ['toolu_read_2']);
  assert.deepEqual(firstResult?.subagentMessages?.map((message) => message.message.content[0].id), ['toolu_read_1']);
  assert.deepEqual(secondResult?.subagentMessages?.map((message) => message.message.content[0].id), ['toolu_read_2']);
});

test('runtime Claude history time-slices legacy resumed agents without parent tool ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-legacy-resumed-agent-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-legacy-resumed-agent';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    {
      sessionId,
      uuid: 'agent-use-1',
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: { description: 'First pass' },
      }] },
    },
    {
      sessionId,
      uuid: 'agent-result-1',
      type: 'user',
      timestamp: '2026-01-01T00:00:01.500Z',
      toolUseResult: { status: 'async_launched', agentId: 'agent-shared' },
      message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'First launch.',
      }] },
    },
    {
      sessionId,
      uuid: 'agent-use-2',
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'toolu_agent_2', name: 'Agent', input: { resume: 'agent-shared' },
      }] },
    },
    {
      sessionId,
      uuid: 'agent-result-2',
      type: 'user',
      timestamp: '2026-01-01T00:00:02.500Z',
      toolUseResult: { status: 'async_launched', agentId: 'agent-shared' },
      message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_agent_2', content: 'Second launch.',
      }] },
    },
  ]);
  await writeJsonl(
    path.join(projectDir, sessionId, 'subagents', 'agent-agent-shared.jsonl'),
    [
      {
        timestamp: '2026-01-01T00:00:01.200Z',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: '/workspace/first.ts' },
        }] },
      },
      {
        timestamp: '2026-01-01T00:00:02.200Z',
        message: { role: 'assistant', content: [{
          type: 'tool_use', id: 'toolu_read_2', name: 'Read', input: { file_path: '/workspace/second.ts' },
        }] },
      },
    ],
  );

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);
  const firstResult = result.messages.find((message) => message.uuid === 'agent-result-1');
  const secondResult = result.messages.find((message) => message.uuid === 'agent-result-2');

  assert.deepEqual(firstResult?.subagentTools?.map((tool) => tool.toolId), ['toolu_read_1']);
  assert.deepEqual(secondResult?.subagentTools?.map((tool) => tool.toolId), ['toolu_read_2']);
  assert.deepEqual(firstResult?.subagentMessages?.map((message) => message.message.content[0].id), ['toolu_read_1']);
  assert.deepEqual(secondResult?.subagentMessages?.map((message) => message.message.content[0].id), ['toolu_read_2']);
});

test('runtime Claude session deletion removes only the target transcript and session data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-delete-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  await writeJsonl(path.join(projectDir, 'session-delete.jsonl'), []);
  await writeJsonl(path.join(projectDir, 'session-keep.jsonl'), []);
  await fs.mkdir(path.join(projectDir, 'session-delete', 'tool-results'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'session-delete', 'subagents'), { recursive: true });
  await writeJsonl(
    path.join(projectDir, 'session-delete', 'display-commands.jsonl'),
    [{ version: 1, messageId: 'message-1', displayCommand: '/report-skill' }],
  );

  assert.equal(await deleteSessionFromProjectsRoot(projectsRoot, 'session-delete'), true);
  await assert.rejects(fs.access(path.join(projectDir, 'session-delete.jsonl')));
  await assert.rejects(fs.access(path.join(projectDir, 'session-delete')));
  await fs.access(path.join(projectDir, 'session-keep.jsonl'));
});
