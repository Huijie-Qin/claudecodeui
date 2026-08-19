import { describe, expect, it } from 'vitest';
import { classifyNavigation, isExactAllowedOrigin } from '../src/shared/origins';
import {
  createSecureWebPreferences,
  isAllowedDownloadRequest,
  isAllowedWebPermission,
} from '../src/shared/security-policy';

const policy = {
  allowedOrigins: new Set(['https://cloudcli.example.com']),
  authOrigins: new Set(['https://login.example.com']),
};

describe('remote navigation policy', () => {
  it('allows only exact application and OAuth origins', () => {
    expect(classifyNavigation('https://cloudcli.example.com/session/123', policy))
      .toBe('allowed');
    expect(classifyNavigation('https://login.example.com/oauth/start', policy))
      .toBe('auth');
    expect(classifyNavigation('https://cloudcli.example.com.evil.test/', policy))
      .toBe('external');
  });

  it('opens only other HTTPS and mailto links externally', () => {
    expect(classifyNavigation('https://docs.example.com/guide', policy)).toBe('external');
    expect(classifyNavigation('mailto:support@example.com', policy)).toBe('external');
    expect(classifyNavigation('http://docs.example.com/', policy)).toBe('denied');
  });

  it('denies dangerous and unknown schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'cloudcli://arbitrary-command',
      'not a URL',
    ]) {
      expect(classifyNavigation(url, policy)).toBe('denied');
    }
  });

  it('does not trust credential-bearing or forged origins', () => {
    expect(isExactAllowedOrigin(
      'https://cloudcli.example.com@evil.test/',
      policy.allowedOrigins,
    )).toBe(false);
    expect(isExactAllowedOrigin(
      'https://cloudcli.example.com.evil.test/',
      policy.allowedOrigins,
    )).toBe(false);
  });

  it('keeps Node APIs and webviews unavailable to remote content', () => {
    expect(createSecureWebPreferences('persist:test')).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: 'persist:test',
    });
  });

  it('denies permissions by default and requires a trusted main frame', () => {
    const allowedOrigins = policy.allowedOrigins;
    expect(isAllowedWebPermission(
      'notifications',
      'https://cloudcli.example.com/session/1',
      true,
      allowedOrigins,
      'https://cloudcli.example.com/',
    )).toBe(true);
    expect(isAllowedWebPermission(
      'media',
      'https://cloudcli.example.com/',
      true,
      allowedOrigins,
    )).toBe(false);
    expect(isAllowedWebPermission(
      'clipboard-read',
      'https://evil.test/',
      true,
      allowedOrigins,
    )).toBe(false);
    expect(isAllowedWebPermission(
      'clipboard-read',
      'https://cloudcli.example.com/',
      false,
      allowedOrigins,
    )).toBe(false);
  });

  it('accepts only user-initiated downloads that stay on trusted origins', () => {
    const allowedOrigins = policy.allowedOrigins;
    expect(isAllowedDownloadRequest(
      'https://cloudcli.example.com/session/1',
      ['blob:https://cloudcli.example.com/download-id'],
      true,
      allowedOrigins,
    )).toBe(true);
    expect(isAllowedDownloadRequest(
      'https://cloudcli.example.com/session/1',
      ['https://cloudcli.example.com/api/files/1'],
      false,
      allowedOrigins,
    )).toBe(false);
    expect(isAllowedDownloadRequest(
      'https://cloudcli.example.com/session/1',
      ['https://cloudcli.example.com/api/files/1', 'https://evil.test/file'],
      true,
      allowedOrigins,
    )).toBe(false);
  });
});
