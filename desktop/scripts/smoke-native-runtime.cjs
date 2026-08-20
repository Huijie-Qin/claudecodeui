'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

function smokeWindowsConsoleAgent(nodeModules) {
  return new Promise((resolve, reject) => {
    const executable = process.env.CLOUDCLI_NODE_EXECUTABLE;
    if (!path.win32.isAbsolute(executable || '')) {
      reject(new Error('Windows native smoke requires packaged CLOUDCLI_NODE_EXECUTABLE.'));
      return;
    }
    const agentPath = path.join(
      nodeModules,
      'node-pty',
      'lib',
      'conpty_console_list_agent.js',
    );
    let stderr = '';
    let receivedMessage = false;
    const agent = fork(agentPath, ['0'], {
      execPath: executable,
      execArgv: [],
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    agent.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    const timeout = setTimeout(() => {
      agent.kill();
      reject(new Error(`Bundled Node console agent timed out: ${stderr}`));
    }, 8_000);
    agent.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    agent.on('message', (message) => {
      receivedMessage = true;
      if (!Array.isArray(message?.consoleProcessList)) {
        clearTimeout(timeout);
        reject(new Error('Bundled Node console agent returned an invalid message.'));
      }
    });
    agent.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !receivedMessage) {
        reject(new Error(
          `Bundled Node console agent exited ${code} without a result: ${stderr}`,
        ));
        return;
      }
      resolve();
    });
  });
}

function smokeWindowsPtyKill(pty, shell) {
  return new Promise((resolve, reject) => {
    const marker = 'cloudcli-windows-pty-kill-ready';
    const terminal = pty.spawn(shell, ['/d', '/q', '/k', `echo ${marker}`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    let output = '';
    let killRequested = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      try {
        terminal.kill();
      } catch {
        // The timeout error below remains the useful failure.
      }
      finish(new Error(`node-pty explicit kill timed out; output: ${JSON.stringify(output)}`));
    }, 12_000);
    terminal.onData((data) => {
      output += data;
      if (!killRequested && output.includes(marker)) {
        killRequested = true;
        try {
          terminal.kill();
        } catch (error) {
          finish(error);
        }
      }
    });
    terminal.onExit(() => {
      if (!killRequested) {
        finish(new Error(`node-pty exited before explicit kill; output: ${JSON.stringify(output)}`));
        return;
      }
      finish();
    });
  });
}

async function smokeNativeRuntime(runtimeDirectory) {
  if (!process.versions.electron) {
    throw new Error('Native runtime smoke must run with the matching Electron ABI runtime.');
  }
  const nodeModules = path.join(runtimeDirectory, 'node_modules');
  const Database = require(path.join(nodeModules, 'better-sqlite3'));
  const bcrypt = require(path.join(nodeModules, 'bcrypt'));
  const pty = require(path.join(nodeModules, 'node-pty'));

  const database = new Database(':memory:');
  try {
    const row = database.prepare('SELECT 43 AS electron_version').get();
    if (row.electron_version !== 43) {
      throw new Error('better-sqlite3 returned an unexpected result.');
    }
  } finally {
    database.close();
  }

  const hash = bcrypt.hashSync('cloudcli-desktop-native-smoke', 4);
  if (!bcrypt.compareSync('cloudcli-desktop-native-smoke', hash)) {
    throw new Error('bcrypt failed its packaged runtime round trip.');
  }

  const marker = 'cloudcli-desktop-pty-smoke-ok';
  const shell = process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `echo ${marker}`]
    : ['-lc', `printf ${marker}`];
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      try {
        terminal.kill();
      } catch {
        // The timeout error below remains the useful failure.
      }
      finish(new Error(`node-pty smoke timed out; output: ${JSON.stringify(output)}`));
    }, 15_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !output.includes(marker)) {
        finish(new Error(
          `node-pty smoke failed with exit ${exitCode}; output: ${JSON.stringify(output)}`,
        ));
        return;
      }
      finish();
    });
  });

  if (process.platform === 'win32') {
    await smokeWindowsPtyKill(pty, shell);
    // The explicit kill above exercises node-pty's patched fork. Run the same
    // console agent directly through the packaged standalone Node as a
    // fail-fast assertion that it can load the Electron-rebuilt N-API binding
    // and complete its IPC handshake instead of taking node-pty's 5s fallback.
    await smokeWindowsConsoleAgent(nodeModules);
  }

  console.log(
    `Packaged native runtime smoke passed (Electron ${process.versions.electron}, ${process.platform}-${process.arch}).`,
  );
}

if (require.main === module) {
  const runtimeDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!runtimeDirectory) {
    console.error('Usage: smoke-native-runtime.cjs <runtime-directory>');
    process.exitCode = 2;
  } else {
    smokeNativeRuntime(runtimeDirectory).catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
  }
}

module.exports = { smokeNativeRuntime };
