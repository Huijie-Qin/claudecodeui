import { pathToFileURL } from 'node:url';

const parentPort = process.parentPort;

function sendToMain(message: unknown): boolean {
  parentPort.postMessage(message);
  return true;
}

// The web/server entry already uses the child-process `process.send` contract.
// Utility processes expose a MessagePort instead, so keep that server contract
// intact and adapt it at this private desktop boundary.
Object.defineProperty(process, 'send', {
  configurable: true,
  enumerable: false,
  value: sendToMain,
  writable: false,
});

parentPort.on('message', (event) => {
  const message = event.data as { type?: unknown } | null;
  if (message?.type === 'shutdown') {
    process.emit('SIGTERM', 'SIGTERM');
    return;
  }

  // Keep the server's private child-process message contract independent of
  // Electron. Only shutdown is consumed by this adapter; request/response
  // messages are forwarded to the bundled server unchanged.
  (process.emit as (event: string, ...args: unknown[]) => boolean)('message', event.data);
});

async function loadBackend(): Promise<void> {
  const backendEntry = process.env.CLOUDCLI_BACKEND_ENTRY;
  if (!backendEntry) {
    throw Object.assign(new Error('CLOUDCLI_BACKEND_ENTRY is not configured.'), {
      code: 'BACKEND_ENTRY_MISSING',
    });
  }

  await import(/* @vite-ignore */ pathToFileURL(backendEntry).href);
}

void loadBackend().catch((error: unknown) => {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {};
  sendToMain({
    type: 'startup-error',
    code: typeof candidate.code === 'string' && candidate.code
      ? candidate.code.toUpperCase().replace(/[^A-Z0-9_-]/gu, '_').slice(0, 128)
      : 'BACKEND_IMPORT_FAILED',
    message: typeof candidate.message === 'string' && candidate.message
      ? candidate.message.slice(0, 2_000)
      : 'The bundled backend could not be loaded.',
  });
  process.exitCode = 1;
});
