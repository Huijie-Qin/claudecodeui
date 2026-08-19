import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('Hook script worker must run inside a worker thread');
}

let nextRequestId = 1;
const pendingRequests = new Map();

function callParent(method, args = []) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, method, args });
  });
}

parentPort.on('message', async (message) => {
  if (message?.type === 'rpc_result') {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.value);
    return;
  }

  if (message?.type !== 'run') return;
  try {
    const ccui = Object.freeze({
      env: Object.freeze({ ...(message.env || {}) }),
      workspace: Object.freeze({
        readText: (filePath) => callParent('workspace.readText', [filePath]),
        writeText: (filePath, content) => callParent('workspace.writeText', [filePath, content]),
        readJson: (filePath) => callParent('workspace.readJson', [filePath]),
        writeJson: (filePath, value) => callParent('workspace.writeJson', [filePath, value]),
        list: (filePath = '.') => callParent('workspace.list', [filePath]),
        exists: (filePath) => callParent('workspace.exists', [filePath]),
      }),
      records: Object.freeze({
        write: (recordType, data) => callParent('records.write', [recordType, data]),
      }),
      log: Object.freeze({
        info: (logMessage, data) => callParent('log.info', [logMessage, data]),
      }),
    });

    const sandbox = {
      console: Object.freeze({
        log: (...args) => callParent('log.info', ['console.log', args]),
        info: (...args) => callParent('log.info', ['console.info', args]),
        warn: (...args) => callParent('log.info', ['console.warn', args]),
        error: (...args) => callParent('log.info', ['console.error', args]),
      }),
      __event: structuredClone(message.event || {}),
      __ccui: ccui,
      __hookPromise: null,
    };
    const context = vm.createContext(sandbox, {
      name: 'ccui-hook-script',
      codeGeneration: { strings: false, wasm: false },
    });
    const transformedCode = String(message.code || '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+(?=(?:async\s+)?function\s+run\b)/g, '');
    const definition = new vm.Script(
      `'use strict';\n${transformedCode}\nif (typeof run !== 'function') { throw new Error('Script must define run(event, ccui)'); }\nglobalThis.__ccuiHookRun = run;`,
      { filename: `hook-${message.hookId || 'script'}.js` },
    );
    definition.runInContext(context, { timeout: 1000 });
    const invocation = new vm.Script(
      `globalThis.__hookPromise = globalThis.__ccuiHookRun(globalThis.__event, globalThis.__ccui);`,
      { filename: `hook-${message.hookId || 'script'}-invoke.js` },
    );
    invocation.runInContext(context, { timeout: 1000 });
    const value = await sandbox.__hookPromise;
    parentPort.postMessage({ type: 'result', value: structuredClone(value ?? null) });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error?.stack || error?.message || String(error),
    });
  }
});
