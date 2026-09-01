import { describe, expect, it } from 'vitest';
import {
  isOfflineDocumentUrl,
  resolveOfflinePageUrl,
} from '../src/main/offline-protocol';

describe('desktop offline page', () => {
  it('uses the development renderer URL when available', () => {
    expect(resolveOfflinePageUrl(
      false,
      'http://127.0.0.1:5174/',
      '/tmp/renderer/index.html',
    )).toBe('http://127.0.0.1:5174/');
  });

  it('uses the bundled renderer file in packaged builds', () => {
    const offlineUrl = resolveOfflinePageUrl(
      true,
      'http://127.0.0.1:5174/',
      '/tmp/renderer/index.html',
    );
    expect(offlineUrl).toBe('file:///tmp/renderer/index.html');
    expect(isOfflineDocumentUrl(offlineUrl, offlineUrl)).toBe(true);
  });
});
