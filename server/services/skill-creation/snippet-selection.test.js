import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillCreator } from './creator.js';
import { parseSelection, validateSelection } from './snippet-selection.js';

const markdown = '---\nname: weekly-report\ndescription: 周报\n---\n根据用户提供的数据生成周报。';
const snippet = { id: 'real', title: '周报', description: '周报要求', markdown: '不得编造数据。' };
const selection = { selected: [{ id: 'real', reason: '与周报相关' }], note: '' };
const args = () => ({ scope: { id: 'job-1' }, description: '生成周报技能', snippets: [snippet], signal: new AbortController().signal, onPhase: () => {} });
const creatorOptions = { instructions: async () => '', onSelectionDiagnostic: () => {} };

test('accepts structured JSON, whitespace, fences and one JSON object with a short explanation', () => {
  const value = { ...selection, note: '字符串内的 { [ ] } 和引号 " 与反斜线 \\ 不影响解析' };
  const json = JSON.stringify(value);
  assert.deepEqual(parseSelection({ structured: value, text: 'ignored' }), value);
  for (const text of [json, `\uFEFF\n${json}\n`, `\n\`\`\`JSON\n${json}\n\`\`\``, `选择结果如下：\n${json}\n以上是选择结果。`, `说明：\n\`\`\`json\n${json}\n\`\`\``]) {
    assert.deepEqual(validateSelection(parseSelection({ text }), [snippet]), value);
  }
});

test('does not guess missing syntax, choose between multiple objects or salvage nested JSON', () => {
  const json = JSON.stringify(selection);
  for (const text of [`${json}\n${json}`, `说明：{"broken":${json}`, `说明：{"selected":[],"note":"",}`, `说明：{broken}\n${json}`, `说明：[${json}`, `说明：${json}]`, 'plain prose', `说明：${json.slice(0, -1)}`]) {
    assert.throws(() => parseSelection({ text }), { code: 'CREATION_SELECTION_ERROR', kind: 'invalid_json' });
  }
  assert.throws(() => parseSelection({ text: ' ' }), { kind: 'empty_response' });
  assert.throws(() => parseSelection({ text: 'x'.repeat(129 * 1024) }), { kind: 'response_too_large' });
});

test('validates the entire batch before accepting any references', () => {
  for (const value of [null, [], { selected: [], note: 4 }, { selected: [], note: '', extra: true }, { selected: [null], note: '' }]) {
    assert.throws(() => validateSelection(value, [snippet]), { kind: 'invalid_fields' });
  }
  for (const id of ['fake', 1]) assert.throws(() => validateSelection({ selected: [{ id, reason: '相关' }], note: '' }, [snippet]), { kind: 'invalid_reference' });
  assert.throws(() => validateSelection({ selected: [selection.selected[0], selection.selected[0]], note: '' }, [snippet, { ...snippet, id: 'second' }]), { kind: 'invalid_reference' });
  for (const reason of [undefined, null, 1, '', ' ', 'x'.repeat(1001)]) {
    assert.throws(() => validateSelection({ selected: [{ id: 'real', reason }], note: '' }, [snippet]), { kind: 'invalid_reason' });
  }
  assert.deepEqual(validateSelection({ selected: [], note: '无相关片段' }, [snippet]).selected, []);
});

test('selection requests constrain IDs and automatically correct once with frozen context', async () => {
  const calls = [], diagnostics = [];
  const creator = createSkillCreator({ ...creatorOptions, onSelectionDiagnostic: data => diagnostics.push(data), modelCall: async call => {
    calls.push(call);
    if (!JSON.parse(call.prompt).catalog) return { text: markdown };
    return calls.length === 1 ? { text: 'not JSON private response', model: 'test-model' } : { structured: selection };
  } });
  const result = await creator(args());
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].outputSchema.properties.selected.items.properties.id.enum, ['real']);
  assert.deepEqual(calls[1].outputSchema, calls[0].outputSchema);
  const first = JSON.parse(calls[0].prompt), retry = JSON.parse(calls[1].prompt);
  assert.deepEqual(retry.catalog, first.catalog);
  assert.equal(retry.description, first.description);
  assert.match(retry.selectionCorrection.error, /片段选择结果格式无效/);
  assert.equal(calls[0].budget, calls[1].budget);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(result.snippets[0].id, 'real');
  assert.equal(result.note, '');
  assert.deepEqual(diagnostics, [{ jobId: 'job-1', model: 'test-model', batch: 1, attempt: 1, kind: 'invalid_json', responseLength: 25, hasStructuredOutput: false, action: 'retry' }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private response|生成周报技能/);
});

test('all selection format failures fall back after exactly two attempts; final skill validation still applies', async () => {
  for (const response of [{ text: '' }, { text: 'bad JSON' }, { structured: { selected: [{ id: 'fake', reason: '相关' }], note: '' } },
    { structured: { selected: [{ id: 'real' }], note: '' } }, { structured: null, text: 'null' }]) {
    let selections = 0;
    const creator = createSkillCreator({ ...creatorOptions, modelCall: async ({ prompt }) => {
      const value = JSON.parse(prompt);
      if (value.catalog) { selections++; return response; }
      assert.deepEqual(value.references, []);
      return { text: markdown };
    } });
    const result = await creator(args());
    assert.equal(selections, 2);
    assert.deepEqual(result.snippets, []);
    assert.match(result.note, /已根据你的描述完成创建/);
  }
  const creator = createSkillCreator({ ...creatorOptions, modelCall: async () => ({ text: 'bad JSON' }) });
  await assert.rejects(creator(args()), { code: 'CREATION_FORMAT_ERROR' });
});

test('partial batch failure keeps only fully validated batches and never passes invented references to generation', async () => {
  const snippets = Array.from({ length: 3 }, (_, index) => ({ ...snippet, id: `s${index}`, description: 'x'.repeat(23900) }));
  const visits = [], diagnostics = [];
  const creator = createSkillCreator({ ...creatorOptions, onSelectionDiagnostic: data => diagnostics.push(data), modelCall: async ({ prompt }) => {
    const value = JSON.parse(prompt);
    if (value.catalog) {
      const id = value.catalog[0].id;
      visits.push(id);
      return { structured: { selected: [{ id: id === 's1' ? 's0' : id, reason: '相关' }], note: '' } };
    }
    assert.equal(value.references.length, 2);
    assert.equal(value.description, args().description);
    return { text: markdown };
  } });
  const result = await creator({ ...args(), snippets });
  assert.deepEqual(visits, ['s0', 's1', 's1', 's2']);
  assert.deepEqual(result.snippets.map(item => item.id), ['s0', 's2']);
  assert.match(result.note, /部分公共参考片段未能采用/);
  assert.equal(diagnostics.at(-1).action, 'skip_batch');
});

test('model failures and cancellation propagate without silently skipping selection', async () => {
  for (const error of [new Error('No credentials'), Object.assign(new Error('Timeout'), { code: 'EVAL_MODEL_TIMEOUT' })]) {
    let calls = 0;
    const creator = createSkillCreator({ ...creatorOptions, modelCall: async () => { calls++; throw error; } });
    await assert.rejects(creator(args()), actual => actual === error);
    assert.equal(calls, 1);
  }
  const controller = new AbortController(); let calls = 0;
  const creator = createSkillCreator({ ...creatorOptions, modelCall: async () => { calls++; controller.abort(new Error('Stopped')); return { text: 'invalid' }; } });
  await assert.rejects(creator({ ...args(), signal: controller.signal }), /Stopped/);
  assert.equal(calls, 1);
});
