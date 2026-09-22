import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillCreator, validateCreatedSkill } from './creator.js';

const markdown = '---\nname: weekly-report\ndescription: "Generate a weekly report"\n---\n# Weekly report\nAsk for missing data.\n\n```json\n{"example":true}\n```';
const args = () => ({ scope: {}, description: '生成周报技能', snippets: [], signal: new AbortController().signal, onPhase: () => {} });

test('accepts leading whitespace/BOM, CRLF and a single outer fence while preserving inner examples', () => {
  const expected = validateCreatedSkill(markdown);
  for (const output of [`\uFEFF\n  ${markdown}\n`, `\n\`\`\`markdown\n${markdown}\n\`\`\`\n`,
    `~~~md\n${markdown}\n~~~`, `\`\`\`\`yaml\r\n${markdown.replaceAll('\n', '\r\n')}\r\n\`\`\`\``]) {
    const parsed = validateCreatedSkill(output);
    assert.equal(parsed.name, expected.name);
    assert.equal(parsed.markdown.replaceAll('\r\n', '\n'), expected.markdown);
    assert.match(parsed.markdown, /```json/);
  }
});

test('missing, unclosed, malformed or incomplete YAML requires format correction', () => {
  for (const output of ['# Skill\nInstructions', 'Here is your skill:\n' + markdown,
    '---\nname: weekly-report\ndescription: Report\n# Body',
    '---\nname: [broken\ndescription: Report\n---\nBody',
    '---\nname: weekly-report\n---\nBody',
    '---\nname: weekly-report\ndescription: Report\n---']) {
    assert.throws(() => validateCreatedSkill(output), { code: 'CREATION_FORMAT_ERROR' });
  }
});

test('format correction runs once with the same frozen references, budget and original request', async () => {
  const calls = [];
  const creator = createSkillCreator({ instructions: async () => 'Skill authoring rules', modelCall: async call => {
    calls.push(call);
    if (JSON.parse(call.prompt).catalog) return { structured: { selected: [{ id: 'public-1', reason: '相关' }], note: '' } };
    return { text: calls.length === 2 ? '# Weekly report\nAsk for missing data.' : markdown };
  } });
  const input = { ...args(), snippets: [{ id: 'public-1', title: 'No invented data', description: 'Reporting rules', markdown: 'Never invent figures.' }] };
  const result = await creator(input);
  assert.equal(result.name, 'weekly-report');
  assert.equal(calls.length, 3);
  const original = JSON.parse(calls[1].prompt), correction = JSON.parse(calls[2].prompt);
  assert.equal(correction.description, input.description);
  assert.deepEqual(correction.references, original.references);
  assert.match(correction.formatCorrection.previousOutput, /^# Weekly report/);
  assert.equal(calls[1].budget, calls[2].budget);
  assert.equal(calls[1].signal, calls[2].signal);
});

test('wrapped valid output needs no second generation and persistently invalid output is bounded', async () => {
  let calls = 0;
  const creator = createSkillCreator({ instructions: async () => '', modelCall: async () => { calls++; return { text: '\n```markdown\n' + markdown + '\n```' }; } });
  assert.equal((await creator(args())).name, 'weekly-report'); assert.equal(calls, 1);
  calls = 0;
  const invalid = createSkillCreator({ instructions: async () => '', modelCall: async () => { calls++; return { text: '# No header' }; } });
  await assert.rejects(invalid(args()), /自动纠正未成功/); assert.equal(calls, 2);
});

test('model failures, oversized responses and cancellation do not trigger format retries', async () => {
  for (const modelCall of [async () => { throw new Error('Model offline'); }, async () => ({ text: 'x'.repeat(129 * 1024) })]) {
    let calls = 0;
    const creator = createSkillCreator({ instructions: async () => '', modelCall: async call => { calls++; return modelCall(call); } });
    await assert.rejects(creator(args())); assert.equal(calls, 1);
  }
  const controller = new AbortController(); let calls = 0;
  const creator = createSkillCreator({ instructions: async () => '', modelCall: async () => {
    calls++; controller.abort(new Error('Stopped')); return { text: '# Invalid' };
  } });
  await assert.rejects(creator({ ...args(), signal: controller.signal }), /Stopped/);
  assert.equal(calls, 1);
});
