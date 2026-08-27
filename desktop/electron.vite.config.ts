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
      css: {
        // The bundled offline page uses plain CSS. Keep its PostCSS pipeline
        // local so a desktop-only install does not discover the web app's
        // root Tailwind configuration and dependencies.
        postcss: {
          plugins: [],
        },
      },
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
