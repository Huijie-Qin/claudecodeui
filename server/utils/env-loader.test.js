import assert from 'node:assert/strict';
import test from 'node:test';

test('applyEnvFileContents lets project .env override existing environment values', async () => {
  const { applyEnvFileContents } = await import('./env-loader.js');
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.siliconflow.cn',
    ANTHROPIC_MODEL: 'Pro/zai-org/GLM-5.1',
  };

  applyEnvFileContents(
    [
      '# Local project config',
      'ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/coding',
      'ANTHROPIC_MODEL=glm-5.1',
      'ANTHROPIC_API_KEY=value=with=equals',
    ].join('\n'),
    env,
  );

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://ark.cn-beijing.volces.com/api/coding');
  assert.equal(env.ANTHROPIC_MODEL, 'glm-5.1');
  assert.equal(env.ANTHROPIC_API_KEY, 'value=with=equals');
});

test('applyEnvFileContents can preserve existing values when override is disabled', async () => {
  const { applyEnvFileContents } = await import('./env-loader.js');
  const env = {
    ANTHROPIC_MODEL: 'global-model',
  };

  applyEnvFileContents('ANTHROPIC_MODEL=local-model', env, { override: false });

  assert.equal(env.ANTHROPIC_MODEL, 'global-model');
});
