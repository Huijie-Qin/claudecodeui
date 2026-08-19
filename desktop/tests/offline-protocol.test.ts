import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: electronMocks.registerSchemesAsPrivileged,
  },
}));

import {
  createOfflineProtocolHandler,
  installOfflineProtocol,
  isOfflineDocumentUrl,
  OFFLINE_PAGE_URL,
  OFFLINE_SCHEME,
  registerOfflineScheme,
  resolveOfflinePageUrl,
} from '../src/main/offline-protocol';

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <script type="module" src="./assets/app-A1.js"></script>
    <link rel="stylesheet" href="./assets/app-B2.css">
  </head>
  <body><img src="./assets/icon-C3.svg" alt=""></body>
</html>`;

describe('offline protocol', () => {
  let rendererRoot: string;

  beforeEach(async () => {
    electronMocks.registerSchemesAsPrivileged.mockReset();
    rendererRoot = await mkdtemp(join(tmpdir(), 'cloudcli-offline-protocol-'));
    await mkdir(join(rendererRoot, 'assets'));
    await Promise.all([
      writeFile(join(rendererRoot, 'index.html'), INDEX_HTML),
      writeFile(join(rendererRoot, 'assets', 'app-A1.js'), 'document.body.dataset.ready = "true";'),
      writeFile(join(rendererRoot, 'assets', 'app-B2.css'), 'body { color: #fff; }'),
      writeFile(join(rendererRoot, 'assets', 'icon-C3.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
      writeFile(join(rendererRoot, 'assets', 'unreferenced.js'), 'throw new Error("not served");'),
    ]);
  });

  afterEach(async () => {
    await rm(rendererRoot, { recursive: true, force: true });
  });

  it('registers a standard secure scheme without extra capabilities', () => {
    registerOfflineScheme();

    expect(electronMocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: OFFLINE_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          bypassCSP: false,
          allowServiceWorkers: false,
          supportFetchAPI: false,
          corsEnabled: false,
          stream: false,
          codeCache: false,
          allowExtensions: false,
        },
      },
    ]);
  });

  it('serves only the entry document and its exact referenced assets', async () => {
    const handler = createOfflineProtocolHandler(rendererRoot);
    const documentResponse = await handler(new Request(OFFLINE_PAGE_URL));

    expect(documentResponse.status).toBe(200);
    expect(documentResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(documentResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(documentResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(documentResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await documentResponse.text()).toBe(INDEX_HTML);

    const scriptResponse = await handler(new Request(`${OFFLINE_PAGE_URL}assets/app-A1.js`));
    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    const unreferencedResponse = await handler(
      new Request(`${OFFLINE_PAGE_URL}assets/unreferenced.js`),
    );
    expect(unreferencedResponse.status).toBe(404);
  });

  it('rejects alternate hosts, encoded paths, queries, and non-read methods', async () => {
    const handler = createOfflineProtocolHandler(rendererRoot);
    const requests = [
      new Request('cloudcli-offline://other/'),
      new Request(`${OFFLINE_PAGE_URL}assets/%2Fapp-A1.js`),
      new Request(`${OFFLINE_PAGE_URL}?redirect=https://example.com`),
    ];

    for (const request of requests) {
      expect((await handler(request)).status).toBe(404);
    }

    const postResponse = await handler(new Request(OFFLINE_PAGE_URL, { method: 'POST' }));
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get('allow')).toBe('GET, HEAD');
  });

  it('supports HEAD without returning the asset body', async () => {
    const handler = createOfflineProtocolHandler(rendererRoot);
    const response = await handler(new Request(OFFLINE_PAGE_URL, { method: 'HEAD' }));

    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await response.text()).toBe('');
  });

  it('matches only the fixed offline document URL', () => {
    expect(isOfflineDocumentUrl(OFFLINE_PAGE_URL)).toBe(true);
    expect(isOfflineDocumentUrl(`${OFFLINE_PAGE_URL}index.html`)).toBe(true);
    expect(isOfflineDocumentUrl(`${OFFLINE_PAGE_URL}assets/app-A1.js`)).toBe(false);
    expect(isOfflineDocumentUrl(`${OFFLINE_PAGE_URL}?unexpected=true`)).toBe(false);
    expect(isOfflineDocumentUrl('cloudcli-offline://other/')).toBe(false);
  });

  it('never lets the development renderer environment override a packaged fallback', () => {
    expect(resolveOfflinePageUrl(true, 'data:text/html,unsafe')).toBe(OFFLINE_PAGE_URL);
    expect(resolveOfflinePageUrl(true, 'file:///private/tmp/unsafe.html')).toBe(OFFLINE_PAGE_URL);
    expect(resolveOfflinePageUrl(true, 'http://127.0.0.1:5174/')).toBe(OFFLINE_PAGE_URL);
    expect(resolveOfflinePageUrl(false, 'http://127.0.0.1:5174/'))
      .toBe('http://127.0.0.1:5174/');
    expect(resolveOfflinePageUrl(false, 'https://evil.example.com/'))
      .toBe(OFFLINE_PAGE_URL);
  });

  it('installs the handler only once per session', () => {
    const handle = vi.fn();
    const session = {
      protocol: {
        isProtocolHandled: vi.fn(() => false),
        handle,
      },
    } as never;

    installOfflineProtocol(session, rendererRoot);
    expect(handle).toHaveBeenCalledWith(OFFLINE_SCHEME, expect.any(Function));

    const duplicateSession = {
      protocol: {
        isProtocolHandled: vi.fn(() => true),
        handle: vi.fn(),
      },
    } as never;
    expect(() => installOfflineProtocol(duplicateSession, rendererRoot))
      .toThrow(`${OFFLINE_SCHEME} protocol is already registered.`);
  });
});
