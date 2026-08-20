import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNodeSpawnSpec,
  createNpmSpawnSpec,
  createNpxSpawnSpec,
  createPluginToolEnvironment,
} from './runtime-command.js';

test('desktop node commands use the bundled standalone runtime', () => {
  const runtimeEnvironment = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    CLOUDCLI_NODE_EXECUTABLE: '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64/node',
    CLOUDCLI_NPM_CLI_PATH: '/Applications/CloudCLI.app/Contents/Resources/runtime/node/darwin-arm64/npm/bin/npm-cli.js',
  };
  const spec = createNodeSpawnSpec(['plugin.js'], {
    runtimeEnvironment,
    environment: { PATH: '/usr/bin', PLUGIN_NAME: 'example' },
  });

  assert.equal(spec.command, runtimeEnvironment.CLOUDCLI_NODE_EXECUTABLE);
  assert.deepEqual(spec.args, ['plugin.js']);
  assert.deepEqual(spec.environment, {
    PATH: '/usr/bin',
    PLUGIN_NAME: 'example',
  });
});

test('desktop npm commands execute the bundled npm CLI through standalone Node', () => {
  const runtimeEnvironment = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    CLOUDCLI_NODE_EXECUTABLE: 'C:\\Program Files\\CloudCLI\\resources\\runtime\\node\\win32-x64\\node.exe',
    CLOUDCLI_NPM_CLI_PATH: 'C:\\Program Files\\CloudCLI\\resources\\runtime\\node\\win32-x64\\npm\\bin\\npm-cli.js',
  };
  const spec = createNpmSpawnSpec(['install', '--ignore-scripts'], {
    runtimeEnvironment,
    environment: { PATH: 'C:\\Windows\\System32' },
    platform: 'win32',
  });

  assert.equal(spec.command, runtimeEnvironment.CLOUDCLI_NODE_EXECUTABLE);
  assert.deepEqual(spec.args, [runtimeEnvironment.CLOUDCLI_NPM_CLI_PATH, 'install', '--ignore-scripts']);
  assert.equal(spec.environment.ELECTRON_RUN_AS_NODE, undefined);
});

test('desktop npx commands execute the sibling bundled npx CLI through standalone Node', () => {
  const runtimeEnvironment = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    CLOUDCLI_NODE_EXECUTABLE: 'C:\\Program Files\\CloudCLI\\resources\\runtime\\node\\win32-x64\\node.exe',
    CLOUDCLI_NPM_CLI_PATH: 'C:\\Program Files\\CloudCLI\\resources\\runtime\\node\\win32-x64\\npm\\bin\\npm-cli.js',
  };
  const spec = createNpxSpawnSpec(['task-master-ai', 'add-task'], {
    runtimeEnvironment,
    environment: { PATH: 'C:\\Windows\\System32' },
    platform: 'win32',
  });

  assert.equal(spec.command, runtimeEnvironment.CLOUDCLI_NODE_EXECUTABLE);
  assert.deepEqual(spec.args, [
    'C:\\Program Files\\CloudCLI\\resources\\runtime\\node\\win32-x64\\npm\\bin\\npx-cli.js',
    'task-master-ai',
    'add-task',
  ]);
  assert.deepEqual(spec.environment, { PATH: 'C:\\Windows\\System32' });
});

test('normal web mode preserves the host npm command and current Node executable', () => {
  const node = createNodeSpawnSpec(['server.js'], {
    runtimeEnvironment: {},
    environment: { PATH: '/bin' },
  });
  const npm = createNpmSpawnSpec(['run', 'build'], {
    runtimeEnvironment: {},
    environment: { PATH: 'C:\\Windows' },
    platform: 'win32',
  });
  const npx = createNpxSpawnSpec(['task-master', 'init'], {
    runtimeEnvironment: {},
    environment: { PATH: 'C:\\Windows' },
    platform: 'win32',
  });

  assert.equal(node.command, process.execPath);
  assert.equal(node.environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(npm.command, 'npm.cmd');
  assert.deepEqual(npm.args, ['run', 'build']);
  assert.equal(npx.command, 'npx.cmd');
  assert.deepEqual(npx.args, ['task-master', 'init']);
});

test('desktop mode fails clearly if its packaged toolchain is incomplete', () => {
  assert.throws(
    () => createNpmSpawnSpec(['install'], {
      runtimeEnvironment: { CLOUDCLI_DESKTOP_MODE: 'true' },
    }),
    (error) => error?.code === 'DESKTOP_PLUGIN_TOOLCHAIN_MISSING',
  );
});

test('desktop plugin tooling does not inherit application secrets', () => {
  const source = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    PATH: '/usr/bin',
    HOME: '/Users/example',
    HTTPS_PROXY: 'http://proxy.example.test',
    NODE_EXTRA_CA_CERTS: '/certs/company.pem',
    ANTHROPIC_API_KEY: 'secret-model-key',
    API_KEY: 'secret-cloudcli-key',
    DATABASE_PATH: '/private/auth.db',
    NPM_TOKEN: 'secret-registry-token',
    npm_config_registry: 'https://registry.example.test',
  };

  assert.deepEqual(createPluginToolEnvironment(source), {
    PATH: '/usr/bin',
    HOME: '/Users/example',
    HTTPS_PROXY: 'http://proxy.example.test',
    NODE_EXTRA_CA_CERTS: '/certs/company.pem',
  });
  assert.deepEqual(createPluginToolEnvironment(source, {
    includeNpmConfiguration: true,
  }), {
    PATH: '/usr/bin',
    HOME: '/Users/example',
    HTTPS_PROXY: 'http://proxy.example.test',
    NODE_EXTRA_CA_CERTS: '/certs/company.pem',
    NPM_TOKEN: 'secret-registry-token',
    npm_config_registry: 'https://registry.example.test',
  });
});
