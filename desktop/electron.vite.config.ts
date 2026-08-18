import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { loadDesktopBuildConfig } from './config/desktop-env';

interface DesktopPackage {
  version: string;
}

export default defineConfig(({ mode }) => {
  const desktopConfig = loadDesktopBuildConfig({ production: mode === 'production' });
  const desktopPackage = JSON.parse(
    readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
  ) as DesktopPackage;
  const definitions = {
    __DESKTOP_HOME_URL__: JSON.stringify(desktopConfig.homeUrl),
    __DESKTOP_UPDATE_BASE_URL__: JSON.stringify(desktopConfig.updateBaseUrl),
    __DESKTOP_ALLOWED_ORIGINS__: JSON.stringify(desktopConfig.allowedOrigins),
    __DESKTOP_AUTH_ORIGINS__: JSON.stringify(desktopConfig.authOrigins),
    __DESKTOP_APP_VERSION__: JSON.stringify(desktopPackage.version),
  };

  return {
    main: {
      define: definitions,
      plugins: [externalizeDepsPlugin()],
    },
    preload: {
      define: definitions,
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      define: definitions,
      build: {
        assetsInlineLimit: 0,
      },
      server: {
        port: 5174,
        strictPort: true,
      },
    },
  };
});
