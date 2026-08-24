import { describe, expect, it } from 'vitest';
import {
  createDirectProxyConfig,
  resolveDesktopHomeUrl,
} from '../src/main/startup-config';

const defaults = {
  argv: [] as string[],
  builtValue: 'https://built.example.com/app',
  production: true,
  allowInsecureHttp: false,
};

describe('desktop startup configuration', () => {
  it('uses command-line, environment, and built values in precedence order', () => {
    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI', '--desktop-home-url=https://cli.example.com/app'],
      environmentValue: 'https://environment.example.com/app',
    })).toBe('https://cli.example.com/app');

    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI'],
      environmentValue: 'https://environment.example.com/app',
    })).toBe('https://environment.example.com/app');

    expect(resolveDesktopHomeUrl(defaults)).toBe('https://built.example.com/app');
  });

  it('supports a separated command-line value and the environment-style flag name', () => {
    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI', '--DESKTOP_HOME_URL', 'https://cli.example.com/'],
    })).toBe('https://cli.example.com/');
  });

  it('applies the desktop URL security policy to runtime overrides', () => {
    expect(() => resolveDesktopHomeUrl({
      ...defaults,
      environmentValue: 'https://user:password@example.com/',
    })).toThrow(/credentials/u);
    expect(() => resolveDesktopHomeUrl({
      ...defaults,
      environmentValue: 'https://example.com/?token=secret',
    })).toThrow(/query or fragment/u);
    expect(() => resolveDesktopHomeUrl({
      ...defaults,
      environmentValue: 'http://example.com/',
    })).toThrow(/HTTPS/u);

    expect(resolveDesktopHomeUrl({
      ...defaults,
      production: false,
      environmentValue: 'http://127.0.0.1:5173/',
    })).toBe('http://127.0.0.1:5173/');
  });

  it('uses direct mode for the dedicated application session', () => {
    expect(createDirectProxyConfig()).toEqual({ mode: 'direct' });
  });
});
