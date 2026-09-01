import { describe, expect, it } from 'vitest';
import {
  createDesktopBuildConfig,
  parseDesktopEnvContents,
} from '../config/desktop-env';

describe('desktop build configuration', () => {
  it('loads only desktop URL settings', () => {
    expect(parseDesktopEnvContents(`
      DESKTOP_HOME_URL=http://cloudcli.example.com/app
      DESKTOP_UPDATE_BASE_URL=http://downloads.example.com/updates
      JWT_SECRET=must-not-be-embedded
    `)).toEqual({
      DESKTOP_HOME_URL: 'http://cloudcli.example.com/app',
      DESKTOP_UPDATE_BASE_URL: 'http://downloads.example.com/updates',
    });
  });

  it('normalizes absolute URLs', () => {
    const config = createDesktopBuildConfig({
      DESKTOP_HOME_URL: 'http://cloudcli.example.com/app',
      DESKTOP_UPDATE_BASE_URL: 'http://downloads.example.com/updates/',
    }, { production: true });

    expect(config).toEqual({
      homeUrl: 'http://cloudcli.example.com/app',
      updateBaseUrl: 'http://downloads.example.com/updates',
    });
  });

  it('requires both URL settings', () => {
    expect(() => createDesktopBuildConfig({
      DESKTOP_HOME_URL: 'http://cloudcli.example.com/',
    }, { production: true })).toThrow(/DESKTOP_UPDATE_BASE_URL/u);
  });
});
