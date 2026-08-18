import { describe, expect, it } from 'vitest';
import {
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
  it('loads only the four explicitly supported keys', () => {
    expect(parseDesktopEnvContents(`
      DESKTOP_HOME_URL=https://cloudcli.example.com
      DATABASE_PATH=/private/database.sqlite
      JWT_SECRET=must-not-be-embedded
      DESKTOP_AUTH_ORIGINS="https://login.example.com"
    `)).toEqual({
      DESKTOP_HOME_URL: 'https://cloudcli.example.com',
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
