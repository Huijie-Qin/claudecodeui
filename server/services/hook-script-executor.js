import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_RESULT_BYTES = 2 * 1024 * 1024;
const HOOK_SCRIPT_API_METHODS = Object.freeze([
  'workspace.readText',
  'workspace.writeText',
  'workspace.readJson',
  'workspace.writeJson',
  'workspace.list',
  'workspace.exists',
  'records.write',
  'log.info',
]);
const PYTHON_EXECUTABLE = process.env.CCUI_HOOK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const WORKER_URL = new URL('./hook-script-worker.js', import.meta.url);
const MODULE_DIR = getModuleDir(import.meta.url);
const APP_ROOT = findAppRoot(MODULE_DIR);
const PYTHON_RUNNER_PATH = path.join(APP_ROOT, 'server', 'services', 'hook-python-runner.py');

function jsonClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingPath(target) {
  let current = target;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function resolveWorkspacePath(workspaceRoot, relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new Error('Workspace path must be a relative string');
  }
  const trimmed = relativePath.trim() || '.';
  if (path.isAbsolute(trimmed)) throw new Error('Workspace path must be relative');
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const target = path.resolve(root, trimmed);
  if (!isInside(root, target) || (!allowRoot && target === root)) {
    throw new Error('Workspace path must stay inside the current workspace');
  }
  const existing = await nearestExistingPath(target);
  const realExisting = await fs.realpath(existing);
  if (!isInside(root, realExisting)) {
    throw new Error('Workspace path crosses a symbolic link outside the current workspace');
  }
  try {
    const realTarget = await fs.realpath(target);
    if (!isInside(root, realTarget)) {
      throw new Error('Workspace path crosses a symbolic link outside the current workspace');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { root, target };
}

function requireText(value, name, maxBytes = MAX_FILE_BYTES) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${name} is too large`);
  return value;
}

function createScriptApiHandler({ workspaceRoot, onRecord, onLog }) {
  return async (method, args) => {
    if (method === 'workspace.readText') {
      const { target } = await resolveWorkspacePath(workspaceRoot, args[0]);
      const stats = await fs.stat(target);
      if (!stats.isFile()) throw new Error('Workspace path is not a file');
      if (stats.size > MAX_FILE_BYTES) throw new Error('Workspace file is larger than 2 MB');
      return fs.readFile(target, 'utf8');
    }
    if (method === 'workspace.writeText') {
      const { root, target } = await resolveWorkspacePath(workspaceRoot, args[0]);
      const content = requireText(args[1], 'content');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const realParent = await fs.realpath(path.dirname(target));
      if (!isInside(root, realParent)) throw new Error('Workspace path escapes through a symbolic link');
      await fs.writeFile(target, content, 'utf8');
      return { path: path.relative(root, target).split(path.sep).join('/'), bytes: Buffer.byteLength(content, 'utf8') };
    }
    if (method === 'workspace.readJson') {
      const text = await createScriptApiHandler({ workspaceRoot, onRecord, onLog })('workspace.readText', args);
      return JSON.parse(text);
    }
    if (method === 'workspace.writeJson') {
      const content = JSON.stringify(args[1], null, 2);
      return createScriptApiHandler({ workspaceRoot, onRecord, onLog })('workspace.writeText', [args[0], `${content}\n`]);
    }
    if (method === 'workspace.list') {
      const { root, target } = await resolveWorkspacePath(workspaceRoot, args[0] || '.', { allowRoot: true });
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        path: path.relative(root, path.join(target, entry.name)).split(path.sep).join('/'),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
    }
    if (method === 'workspace.exists') {
      try {
        const { target } = await resolveWorkspacePath(workspaceRoot, args[0], { allowRoot: true });
        await fs.access(target);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (method === 'records.write') {
      const recordType = requireText(args[0], 'record type', 120).trim();
      if (!recordType) throw new Error('record type is required');
      const data = jsonClone(args[1]);
      if (jsonSize(data) > MAX_FILE_BYTES) throw new Error('record data is larger than 2 MB');
      return onRecord(recordType, data);
    }
    if (method === 'log.info') {
      const message = requireText(args[0], 'log message', 4000);
      const data = jsonClone(args[1]);
      return onLog(message, data);
    }
    throw new Error(`Unsupported CCUI script API: ${method}`);
  };
}

function validateScriptResult(value) {
  const normalized = jsonClone(value);
  if (jsonSize(normalized) > MAX_SCRIPT_RESULT_BYTES) {
    throw new Error('Hook script result is larger than 2 MB');
  }
  return normalized;
}

function createAbortError() {
  const error = new Error('Hook script was aborted');
  error.name = 'AbortError';
  return error;
}

function runJavaScript({ hookId, code, event, env, apiHandler, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      type: 'module',
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      void worker.terminate();
      callback(value);
    };
    const handleAbort = () => finish(reject, createAbortError());
    const timer = setTimeout(
      () => finish(reject, new Error(`JavaScript Hook script timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    worker.on('message', async (message) => {
      if (message?.type === 'rpc') {
        try {
          const value = await apiHandler(message.method, message.args || []);
          worker.postMessage({ type: 'rpc_result', id: message.id, value });
        } catch (error) {
          worker.postMessage({ type: 'rpc_result', id: message.id, error: error?.message || String(error) });
        }
      } else if (message?.type === 'result') {
        try {
          finish(resolve, validateScriptResult(message.value));
        } catch (error) {
          finish(reject, error);
        }
      } else if (message?.type === 'error') {
        finish(reject, new Error(message.error || 'JavaScript Hook script failed'));
      }
    });
    worker.on('error', (error) => finish(reject, error));
    worker.on('exit', (codeValue) => {
      if (!settled && codeValue !== 0) finish(reject, new Error(`JavaScript Hook worker exited with code ${codeValue}`));
    });
    if (signal?.aborted) {
      finish(reject, createAbortError());
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage({ type: 'run', hookId, code, event: jsonClone(event), env: jsonClone(env) });
  });
}

function runPython({ hookId, code, event, env, apiHandler, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXECUTABLE, ['-I', '-S', '-u', PYTHON_RUNNER_PATH], {
      cwd: path.dirname(PYTHON_RUNNER_PATH),
      env: Object.fromEntries(
        ['PATH', 'Path', 'SystemRoot', 'WINDIR'].flatMap((name) => (
          process.env[name] ? [[name, process.env[name]]] : []
        )),
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stdoutBuffer = '';
    let stderr = '';
    let messageChain = Promise.resolve();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      child.kill();
      callback(value);
    };
    const handleAbort = () => finish(reject, createAbortError());
    const timer = setTimeout(
      () => finish(reject, new Error(`Python Hook script timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const handleLine = async (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error('Python Hook runner returned invalid JSON');
      }
      if (message.type === 'rpc') {
        try {
          const value = await apiHandler(message.method, message.args || []);
          child.stdin.write(`${JSON.stringify({ id: message.id, value })}\n`);
        } catch (error) {
          child.stdin.write(`${JSON.stringify({ id: message.id, error: error?.message || String(error) })}\n`);
        }
      } else if (message.type === 'result') {
        finish(resolve, validateScriptResult(message.value));
      } else if (message.type === 'error') {
        finish(reject, new Error(message.error || 'Python Hook script failed'));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        messageChain = messageChain.then(() => handleLine(line));
      }
      messageChain.catch((error) => finish(reject, error));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('exit', (exitCode) => {
      if (!settled) {
        finish(reject, new Error(stderr.trim() || `Python Hook runner exited with code ${exitCode}`));
      }
    });
    if (signal?.aborted) {
      finish(reject, createAbortError());
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    child.stdin.write(`${JSON.stringify({ hookId, code, event: jsonClone(event), env: jsonClone(env) })}\n`);
  });
}

export async function executeHookScript({
  hookId,
  language,
  code,
  event,
  env,
  workspaceRoot,
  onRecord = async () => null,
  onLog = async () => null,
  signal,
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
}) {
  const apiHandler = createScriptApiHandler({ workspaceRoot, onRecord, onLog });
  const input = { hookId, code, event, env, apiHandler, signal, timeoutMs };
  return language === 'python' ? runPython(input) : runJavaScript(input);
}

export { HOOK_SCRIPT_API_METHODS, resolveWorkspacePath };
