import { describe, expect, it } from 'vitest';
import {
  createDirectProxyConfig,
  resolveDesktopHomeUrl,
} from '../src/main/startup-config';

const defaults = {
  argv: [] as string[],
  builtValue: 'http://built.example.com/app',
};

describe('desktop startup configuration', () => {
  it('uses command-line, environment, and built values in precedence order', () => {
    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI', '--desktop-home-url=http://cli.example.com/app'],
      environmentValue: 'http://environment.example.com/app',
    })).toBe('http://cli.example.com/app');

    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI'],
      environmentValue: 'http://environment.example.com/app',
    })).toBe('http://environment.example.com/app');

    expect(resolveDesktopHomeUrl(defaults)).toBe('http://built.example.com/app');
  });

  it('supports a separated command-line value', () => {
    expect(resolveDesktopHomeUrl({
      ...defaults,
      argv: ['CloudCLI', '--DESKTOP_HOME_URL', 'http://cli.example.com/'],
    })).toBe('http://cli.example.com/');
  });

  it('uses direct mode for the dedicated application session', () => {
    expect(createDirectProxyConfig()).toEqual({ mode: 'direct' });
  });
});
