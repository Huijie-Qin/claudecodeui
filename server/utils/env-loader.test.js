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

test('desktop environment paths load the user config after the packaged app config', async () => {
  const { resolveEnvFilePaths } = await import('./env-loader.js');

  assert.deepEqual(resolveEnvFilePaths({
    appRoot: '/Applications/CloudCLI.app/Contents/Resources/runtime',
    userHome: '/Users/tester',
    desktopMode: true,
  }), [
    '/Applications/CloudCLI.app/Contents/Resources/runtime/.env',
    '/Users/tester/.cloudcli/.env',
  ]);
  assert.deepEqual(resolveEnvFilePaths({
    appRoot: '/srv/cloudcli',
    userHome: '/Users/tester',
    desktopMode: false,
  }), ['/srv/cloudcli/.env']);
});

test('desktop user environment values override packaged defaults before safety enforcement', async () => {
  const { applyEnvFileContents, resolveEnvFilePaths } = await import('./env-loader.js');
  const env = {};
  const contentsByPath = new Map([
    ['/app/.env', 'ANTHROPIC_MODEL=packaged-model\nHOST=0.0.0.0'],
    ['/home/.cloudcli/.env', 'ANTHROPIC_MODEL=user-model\nCLAUDE_EXECUTION_MODE=docker'],
  ]);

  for (const envPath of resolveEnvFilePaths({
    appRoot: '/app',
    userHome: '/home',
    desktopMode: true,
  })) {
    applyEnvFileContents(contentsByPath.get(envPath), env);
  }

  assert.deepEqual(env, {
    ANTHROPIC_MODEL: 'user-model',
    HOST: '0.0.0.0',
    CLAUDE_EXECUTION_MODE: 'docker',
  });
});
