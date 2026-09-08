import assert from 'node:assert/strict';
import test from 'node:test';

import { extractSessionLearningExample, learnSessionSkill } from './session-skill-learning.js';

const messages = [
  { id: 'u1', kind: 'text', role: 'user', content: '计算 12 元和 8 元的合计。' },
  { id: 'a1', kind: 'text', role: 'assistant', content: '20元' },
  { id: 'u2', kind: 'text', role: 'user', content: '金额保留两位小数，输出 JSON，字段名 total。' },
  { id: 'a2', kind: 'text', role: 'assistant', content: '{"total":"20.00"}' },
  { id: 'u3', kind: 'text', role: 'user', content: '满意了' },
];
const skill = (method) => `---\nname: total-price\ndescription: 汇总输入金额并输出指定格式。\n---\n${method}\n`;
const summary = JSON.stringify({ input: '输入金额为12和8，计算合计并保留两位小数，输出JSON字段total。', requiresExternalData: false, unfinished: false, reason: '' });
const verdict = (passed, feedback = passed ? '金额、两位小数和字段均一致。' : '金额必须保留两位小数。') => JSON.stringify({ passed, feedback });

test('history extracts user inputs and final assistant text, excluding tools and hidden messages', () => {
  const result = extractSessionLearningExample([
    ...messages,
    { kind: 'tool_use', role: 'assistant', content: 'not final' },
    { kind: 'text', role: 'assistant', content: 'hidden', isMeta: true },
    { kind: 'text', role: 'user', content: 'hook recovery', origin: 'hook' },
  ]);
  assert.equal(result.expectedOutput, '{"total":"20.00"}');
  assert.equal(result.finalMessageId, 'a2');
  assert.deepEqual(result.userMessages.map((entry) => entry.id), ['u1', 'u2', 'u3']);
  assert.equal(result.userMessages[2].afterFinalOutput, true);
});

test('generation learns by replaying and repairing; executor never receives expected output or history', async () => {
  const calls = [];
  let replay = 0;
  const result = await learnSessionSkill({
    skillName: 'total-price', messages,
    complete: async ({ phase, prompt }) => {
      const data = JSON.parse(prompt);
      calls.push({ phase, data });
      if (phase === 'summarize') {
        assert.equal(data.userMessages.some((entry) => entry.content.includes('20.00')), false);
        return summary;
      }
      if (phase === 'select-output') return '{"id":"output-2","reason":"最后修正的结果"}';
      if (phase === 'generate') return skill('对所有金额求和，返回 total 字段。');
      if (phase === 'optimize') {
        assert.equal(data.failures[0].passed, false);
        return skill('对所有输入金额求和。金额转为固定两位小数字符串，输出JSON对象的total字段。');
      }
      if (phase === 'execute') {
        assert.deepEqual(Object.keys(data).sort(), ['input', 'skill']);
        assert.equal(prompt.includes('20.00'), false);
        return ++replay === 1 ? '{"total":20}' : '{"total":"20.00"}';
      }
      if (phase === 'judge') return verdict(data.actualOutput === data.expectedOutput);
      throw new Error('Unexpected phase');
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].passed, false);
  assert.deepEqual(calls.map((entry) => entry.phase), ['summarize', 'select-output', 'generate', 'execute', 'judge', 'optimize', 'execute', 'judge']);
  assert.equal(result.testCases.length, 1);
});

test('optimization checks the original skill first and repairs regressions on previous cases', async () => {
  let generationCount = 0;
  let replayCount = 0;
  const oldSkill = skill('金额求和，输出小数字符串。');
  const result = await learnSessionSkill({
    skillName: 'total-price', operation: 'optimize', messages, currentSkill: oldSkill,
    previousCases: [{ input: '输入金额 1 和 2，返回 JSON total 两位小数。', expectedOutput: '{"total":"3.00"}' }],
    complete: async ({ phase, prompt }) => {
      const data = JSON.parse(prompt);
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') return '{"id":"output-2","reason":"最后修正的结果"}';
      if (phase === 'generate') throw new Error('Optimization must evaluate the existing skill first');
      if (phase === 'optimize') {
        generationCount += 1;
        assert.equal(data.examples.length, 2);
        return skill('对任意输入金额求和并固定两位小数，以JSON total字段输出。');
      }
      if (phase === 'execute') {
        replayCount += 1;
        const oldCase = data.input.includes('1 和 2');
        if (replayCount <= 2) assert.equal(data.skill, oldSkill);
        if (!generationCount) return oldCase ? '{"total":"3.00"}' : '{"total":20}';
        // First repair breaks the old case even though the new case now works.
        return oldCase ? (generationCount === 1 ? '{"total":3}' : '{"total":"3.00"}') : '{"total":"20.00"}';
      }
      return verdict(data.expectedOutput === data.actualOutput);
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.iterations.length, 3);
  assert.equal(result.iterations[1].checks[0].passed, false);
  assert.equal(result.iterations[1].checks[1].passed, true);
  assert.equal(replayCount, 6);
});

test('exhaustion retains failed actual output and stops at the configured limit', async () => {
  let executeCount = 0;
  const result = await learnSessionSkill({
    skillName: 'total-price', messages, maxIterations: 2,
    complete: async ({ phase }) => {
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') return '{"id":"output-2","reason":"最终结果"}';
      if (phase === 'generate' || phase === 'optimize') return skill('汇总金额。');
      if (phase === 'execute') { executeCount += 1; return 'wrong'; }
      return verdict(false);
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.actualOutput, 'wrong');
  assert.equal(executeCount, 2);
  assert.equal(result.iterations.length, 2);
});

test('missing external data and unfinished requests fail before generation or execution', async () => {
  for (const status of [
    { requiresExternalData: true, unfinished: false },
    { requiresExternalData: false, unfinished: true },
  ]) {
    const phases = [];
    await assert.rejects(learnSessionSkill({
      skillName: 'total-price', messages,
      complete: async ({ phase }) => {
        phases.push(phase);
        return JSON.stringify({ input: '任务', ...status, reason: '需要补充材料或完成回答' });
      },
    }), /completed, self-contained/);
    assert.deepEqual(phases, ['summarize']);
  }
});

test('malformed judge output is not treated as a successful evaluation', async () => {
  await assert.rejects(learnSessionSkill({
    skillName: 'total-price', messages,
    complete: async ({ phase }) => {
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') return '{"id":"output-2","reason":"最后修正的结果"}';
      if (phase === 'generate') return skill('求和');
      if (phase === 'execute') return '{"total":"20.00"}';
      return '{"passed":"true","feedback":"looks fine"}';
    },
  }), /boolean/);
});

test('invalid generated skill and invalid iteration limit fail clearly', async () => {
  await assert.rejects(learnSessionSkill({ skillName: 'total-price', messages, maxIterations: 0, complete: async () => '' }), /maxIterations/);
  await assert.rejects(learnSessionSkill({
    skillName: 'total-price', messages,
    complete: async ({ phase }) => phase === 'summarize' ? summary : phase === 'select-output' ? '{"id":"output-2"}' : 'This is just a summary, not a skill.',
  }), /frontmatter/);
});

test('a trailing courtesy reply is not the target and the chosen output remains verbatim', async () => {
  const result = await learnSessionSkill({
    skillName: 'total-price', messages: [...messages, { id: 'a3', role: 'assistant', kind: 'text', content: '不客气！' }],
    complete: async ({ phase, prompt }) => {
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') {
        assert.equal(JSON.parse(prompt).candidates.at(-1).content, '不客气！');
        return '{"id":"output-2","reason":"最终任务结果，之后是寒暄"}';
      }
      if (phase === 'generate') return skill('求和并按输入要求格式化');
      if (phase === 'execute') return '{"total":"20.00"}';
      return verdict(true);
    },
  });
  assert.equal(result.expectedOutput, '{"total":"20.00"}');
  assert.equal(result.finalMessageId, 'a2');
});

test('an author copying the complete target into a skill example is repaired before replay', async () => {
  let executions = 0;
  const result = await learnSessionSkill({
    skillName: 'total-price', messages,
    complete: async ({ phase, prompt }) => {
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') return '{"id":"output-2"}';
      if (phase === 'generate') return skill('求和并格式化。例如：{ "total": "20.00" }');
      if (phase === 'optimize') {
        assert.equal(JSON.parse(prompt).failures[0].actualOutput, '');
        return skill('对输入金额求和并保留两位小数，输出 {"total":"<金额>"}。');
      }
      if (phase === 'execute') { executions += 1; return '{"total":"20.00"}'; }
      return verdict(true);
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].actualOutput, '');
  assert.equal(executions, 1);
});

test('a corrected target supersedes a previous target for the identical input', async () => {
  const result = await learnSessionSkill({
    skillName: 'total-price', operation: 'optimize', messages, currentSkill: skill('按用户格式要求求和。'),
    previousCases: [{ input: JSON.parse(summary).input, expectedOutput: '{"total":20}' }],
    complete: async ({ phase }) => {
      if (phase === 'summarize') return summary;
      if (phase === 'select-output') return '{"id":"output-2"}';
      if (phase === 'execute') return '{"total":"20.00"}';
      if (phase === 'judge') return verdict(true);
      throw new Error('An unnecessary repair was requested');
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.testCases.length, 1);
  assert.equal(result.testCases[0].expectedOutput, '{"total":"20.00"}');
});
