import { describe, expect, it } from 'vitest';
import {
  assertDesktopSigningPolicy,
  createDesktopBuildConfig,
  parseDesktopEnvContents,
} from '../config/desktop-env';

const productionConfig = {
  DESKTOP_HOME_URL: 'https://cloudcli.example.com/app',
  DESKTOP_UPDATE_BASE_URL: 'https://downloads.example.com/api/desktop-updates/',
  DESKTOP_ALLOWED_ORIGINS: 'https://cloudcli.example.com,https://assets.example.com',
  DESKTOP_AUTH_ORIGINS: 'https://login.example.com',
};

describe('desktop build configuration', () => {
  it('loads only the explicitly supported keys', () => {
    expect(parseDesktopEnvContents(`
      DESKTOP_HOME_URL=https://cloudcli.example.com
      DESKTOP_ALLOW_INSECURE_HTTP=true
      DATABASE_PATH=/private/database.sqlite
      JWT_SECRET=must-not-be-embedded
      DESKTOP_AUTH_ORIGINS="https://login.example.com"
    `)).toEqual({
      DESKTOP_HOME_URL: 'https://cloudcli.example.com',
      DESKTOP_ALLOW_INSECURE_HTTP: 'true',
      DESKTOP_AUTH_ORIGINS: 'https://login.example.com',
    });
  });

  it('normalizes URLs and includes the home origin', () => {
    const config = createDesktopBuildConfig(productionConfig, { production: true });
    expect(config.homeUrl).toBe('https://cloudcli.example.com/app');
    expect(config.updateBaseUrl).toBe('https://downloads.example.com/api/desktop-updates');
    expect(config.allowedOrigins).toEqual([
      'https://cloudcli.example.com',
      'https://assets.example.com',
    ]);
    expect(config.authOrigins).toEqual(['https://login.example.com']);
    expect(config.allowInsecureHttp).toBe(false);
  });

  it('allows explicit HTTP application and update origins', () => {
    const config = createDesktopBuildConfig({
      DESKTOP_ALLOW_INSECURE_HTTP: 'true',
      DESKTOP_HOME_URL: 'http://10.0.0.8:3001/app',
      DESKTOP_UPDATE_BASE_URL: 'http://10.0.0.8:3001/api/desktop-updates/',
      DESKTOP_ALLOWED_ORIGINS: 'http://10.0.0.8:3001,http://assets.internal',
      DESKTOP_AUTH_ORIGINS: 'http://login.internal',
    }, { production: true });

    expect(config.homeUrl).toBe('http://10.0.0.8:3001/app');
    expect(config.updateBaseUrl).toBe('http://10.0.0.8:3001/api/desktop-updates');
    expect(config.allowedOrigins).toEqual([
      'http://10.0.0.8:3001',
      'http://assets.internal',
    ]);
    expect(config.authOrigins).toEqual(['http://login.internal']);
    expect(config.allowInsecureHttp).toBe(true);

    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_UPDATE_BASE_URL: 'http://downloads.example.com/api/desktop-updates',
    }, { production: true })).toThrow(/DESKTOP_UPDATE_BASE_URL must use HTTPS/u);

    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_UPDATE_BASE_URL: 'http://127.0.0.1:3001/api/desktop-updates',
    }, { production: false })).toThrow(/DESKTOP_UPDATE_BASE_URL must use HTTPS/u);
  });

  it('rejects invalid insecure HTTP flags and signed insecure builds', () => {
    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_ALLOW_INSECURE_HTTP: 'yes',
    }, { production: true })).toThrow(/exactly true or false/u);

    const insecureConfig = createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_ALLOW_INSECURE_HTTP: 'true',
    }, { production: true });
    expect(() => assertDesktopSigningPolicy(insecureConfig, { requireSigning: true }))
      .toThrow(/not permitted/u);
    expect(() => assertDesktopSigningPolicy(insecureConfig, { requireSigning: false }))
      .not.toThrow();
  });

  it('fails production builds for missing or insecure values', () => {
    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_HOME_URL: 'http://cloudcli.example.com',
    }, { production: true })).toThrow(/HTTPS/u);

    const { DESKTOP_AUTH_ORIGINS: _omitted, ...missing } = productionConfig;
    expect(() => createDesktopBuildConfig(missing, { production: true }))
      .toThrow(/DESKTOP_AUTH_ORIGINS/u);
  });

  it('rejects credentials and non-origin allowlist entries', () => {
    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_HOME_URL: 'https://user:password@cloudcli.example.com',
    }, { production: true })).toThrow(/credentials/u);

    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_ALLOWED_ORIGINS: 'https://cloudcli.example.com/admin',
    }, { production: true })).toThrow(/must be origins/u);

    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_HOME_URL: 'https://cloudcli.example.com/?token=do-not-embed',
    }, { production: true })).toThrow(/query or fragment/u);
  });

  it('keeps application and OAuth origins disjoint', () => {
    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_AUTH_ORIGINS: 'https://cloudcli.example.com',
    }, { production: true })).toThrow(/must not overlap/u);

    expect(() => createDesktopBuildConfig({
      ...productionConfig,
      DESKTOP_ALLOWED_ORIGINS: 'https://assets.example.com,https://login.example.com',
    }, { production: true })).toThrow(/must not overlap/u);
  });
});
