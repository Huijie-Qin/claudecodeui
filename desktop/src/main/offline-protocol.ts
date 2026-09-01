import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveOfflinePageUrl(
  isPackaged: boolean,
  developmentRendererUrl?: string,
  rendererFile = join(__dirname, '../renderer/index.html'),
): string {
  if (!isPackaged && developmentRendererUrl) {
    return new URL(developmentRendererUrl).href;
  }
  return pathToFileURL(rendererFile).href;
}

export function isOfflineDocumentUrl(url: string, offlinePageUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const expected = new URL(offlinePageUrl);
    return candidate.href === expected.href;
  } catch {
    return false;
  }
}
