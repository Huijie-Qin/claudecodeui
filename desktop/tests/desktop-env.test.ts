import { describe, expect, it } from 'vitest';
import {
  createDesktopBuildConfig,
  parseDesktopEnvContents,
} from '../config/desktop-env';

describe('desktop build configuration', () => {
  it('loads only the updater URL and never embeds server secrets or remote app origins', () => {
    expect(parseDesktopEnvContents(`
      DESKTOP_UPDATE_BASE_URL="https://downloads.example.com/api/desktop-updates/"
      DESKTOP_HOME_URL=https://cloudcli.example.com
      DESKTOP_ALLOWED_ORIGINS=https://cloudcli.example.com
      DATABASE_PATH=/private/database.sqlite
      JWT_SECRET=must-not-be-embedded
    `)).toEqual({
      DESKTOP_UPDATE_BASE_URL: 'https://downloads.example.com/api/desktop-updates/',
    });
  });

  it('normalizes the updater base URL', () => {
    expect(createDesktopBuildConfig({
      DESKTOP_UPDATE_BASE_URL: 'https://downloads.example.com/api/desktop-updates///',
    }, { production: true })).toEqual({
      updateBaseUrl: 'https://downloads.example.com/api/desktop-updates',
    });
  });

  it('requires a secure absolute updater URL without credentials or dynamic URL data', () => {
    expect(() => createDesktopBuildConfig({}, { production: true }))
      .toThrow(/DESKTOP_UPDATE_BASE_URL/u);
    expect(() => createDesktopBuildConfig({
      DESKTOP_UPDATE_BASE_URL: 'http://downloads.example.com/updates',
    }, { production: true })).toThrow(/HTTPS/u);
    expect(() => createDesktopBuildConfig({
      DESKTOP_UPDATE_BASE_URL: '/api/desktop-updates',
    }, { production: true })).toThrow(/absolute URL/u);
    expect(() => createDesktopBuildConfig({
      DESKTOP_UPDATE_BASE_URL: 'https://user:password@downloads.example.com/updates',
    }, { production: true })).toThrow(/credentials/u);
    expect(() => createDesktopBuildConfig({
      DESKTOP_UPDATE_BASE_URL: 'https://downloads.example.com/updates?channel=stable',
    }, { production: true })).toThrow(/query or fragment/u);
  });
});
