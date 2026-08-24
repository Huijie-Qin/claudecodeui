import { lstat, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { protocol, type Session } from 'electron';

export const OFFLINE_SCHEME = 'cloudcli-offline';
export const OFFLINE_HOST = 'app';
export const OFFLINE_PAGE_URL = `${OFFLINE_SCHEME}://${OFFLINE_HOST}/`;
const DEVELOPMENT_RENDERER_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const MIME_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:css|js|svg)$/u;
const RESOURCE_ATTRIBUTE = /\b(?:href|src)=["']([^"']+)["']/gu;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

interface OfflineAsset {
  body: ArrayBuffer;
  contentType: string;
}

function secureHeaders(contentType: string, contentLength: number): Record<string, string> {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Length': String(contentLength),
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Expires: '0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function errorResponse(status: number, message: string, method = 'GET'): Response {
  const body = new TextEncoder().encode(message);
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: secureHeaders('text/plain; charset=utf-8', body.byteLength),
  });
}

function resolveContainedFile(rootDirectory: string, relativePath: string): string {
  if (relativePath !== 'index.html' && !SAFE_ASSET_PATH.test(relativePath)) {
    throw new Error('Offline asset is not in the fixed file allowlist.');
  }

  const root = resolve(rootDirectory);
  const candidate = resolve(root, relativePath);
  const pathFromRoot = relative(root, candidate);
  if (
    !pathFromRoot
    || pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || candidate === root
  ) {
    throw new Error('Offline asset path escapes the renderer directory.');
  }
  return candidate;
}

async function readAsset(rootDirectory: string, relativePath: string): Promise<OfflineAsset> {
  const extension = extname(relativePath).toLowerCase();
  const contentType = MIME_TYPES.get(extension);
  if (!contentType) {
    throw new Error(`Unsupported offline asset type: ${extension || '(none)'}.`);
  }

  const filePath = resolveContainedFile(rootDirectory, relativePath);
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ASSET_BYTES) {
    throw new Error(`Invalid offline asset: ${relativePath}.`);
  }

  const file = await readFile(filePath);
  return {
    body: Uint8Array.from(file).buffer,
    contentType,
  };
}

function getReferencedAssets(indexContents: string): Set<string> {
  const assets = new Set<string>();
  for (const match of indexContents.matchAll(RESOURCE_ATTRIBUTE)) {
    const reference = match[1];
    const relativePath = reference.startsWith('./')
      ? reference.slice(2)
      : reference.startsWith('/')
        ? reference.slice(1)
        : '';
    if (!relativePath || !SAFE_ASSET_PATH.test(relativePath)) {
      throw new Error(`Invalid offline resource reference: ${reference}.`);
    }
    assets.add(relativePath);
  }
  return assets;
}

async function createAssetManifest(rootDirectory: string): Promise<Map<string, OfflineAsset>> {
  const indexAsset = await readAsset(rootDirectory, 'index.html');
  const indexContents = new TextDecoder().decode(indexAsset.body);
  const referencedAssets = getReferencedAssets(indexContents);
  const manifest = new Map<string, OfflineAsset>([
    ['/', indexAsset],
    ['/index.html', indexAsset],
  ]);
  let totalBytes = indexAsset.body.byteLength;

  for (const relativePath of referencedAssets) {
    const asset = await readAsset(rootDirectory, relativePath);
    totalBytes += asset.body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Offline renderer exceeds the maximum allowed size.');
    }
    manifest.set(`/${relativePath}`, asset);
  }

  return manifest;
}

function requestPath(url: string): string | null {
  if (url.includes('\\') || url.includes('%')) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== `${OFFLINE_SCHEME}:`
      || parsed.hostname !== OFFLINE_HOST
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.pathname;
  } catch {
    return null;
  }
}

export function isOfflineDocumentUrl(url: string): boolean {
  const pathname = requestPath(url);
  return pathname === '/' || pathname === '/index.html';
}

export function resolveOfflinePageUrl(
  isPackaged: boolean,
  developmentRendererUrl?: string,
): string {
  if (isPackaged || !developmentRendererUrl) {
    return OFFLINE_PAGE_URL;
  }

  try {
    const parsed = new URL(developmentRendererUrl);
    const isLoopbackRenderer = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && DEVELOPMENT_RENDERER_HOSTS.has(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
    return isLoopbackRenderer ? parsed.href : OFFLINE_PAGE_URL;
  } catch {
    return OFFLINE_PAGE_URL;
  }
}

export function registerOfflineScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: OFFLINE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        allowServiceWorkers: false,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: false,
        codeCache: false,
        allowExtensions: false,
      },
    },
  ]);
}

export function createOfflineProtocolHandler(
  rootDirectory: string,
): (request: Request) => Promise<Response> {
  let manifest: Promise<Map<string, OfflineAsset>> | null = null;
  const getManifest = (): Promise<Map<string, OfflineAsset>> => {
    manifest ??= createAssetManifest(rootDirectory);
    return manifest;
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const response = errorResponse(405, 'Method Not Allowed', request.method);
      response.headers.set('Allow', 'GET, HEAD');
      return response;
    }

    const pathname = requestPath(request.url);
    if (!pathname) {
      return errorResponse(404, 'Not Found', request.method);
    }

    try {
      const asset = (await getManifest()).get(pathname);
      if (!asset) {
        return errorResponse(404, 'Not Found', request.method);
      }
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        status: 200,
        headers: secureHeaders(asset.contentType, asset.body.byteLength),
      });
    } catch (error) {
      console.error('[desktop] Failed to load the offline renderer.', error);
      return errorResponse(500, 'Offline page unavailable', request.method);
    }
  };
}

export function installOfflineProtocol(
  desktopSession: Session,
  rootDirectory = resolve(__dirname, '../renderer'),
): void {
  if (desktopSession.protocol.isProtocolHandled(OFFLINE_SCHEME)) {
    throw new Error(`${OFFLINE_SCHEME} protocol is already registered.`);
  }
  desktopSession.protocol.handle(
    OFFLINE_SCHEME,
    createOfflineProtocolHandler(rootDirectory),
  );
}
