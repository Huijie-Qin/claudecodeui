import type { Configuration } from 'electron-builder';
import { loadDesktopBuildConfig } from './config/desktop-env';

const desktopConfig = loadDesktopBuildConfig({ production: true });
const requireSigning = process.env.DESKTOP_REQUIRE_SIGNING === 'true';
const buildingWindows = process.argv.some((argument) => ['--win', '--windows', '-w'].includes(argument));
const buildingMac = process.argv.some((argument) => ['--mac', '--macos', '-m'].includes(argument));
const updatePlatform = buildingWindows ? 'win' : buildingMac ? 'mac'
  : process.platform === 'darwin' ? 'mac' : 'win';
const updateArch = updatePlatform === 'mac' ? 'universal' : 'x64';

const config: Configuration = {
  appId: 'ai.cloudcli.desktop',
  productName: 'CloudCLI',
  asar: true,
  compression: 'maximum',
  electronLanguages: ['en', 'zh_CN'],
  directories: {
    buildResources: 'build',
    output: 'dist/${os}-${arch}',
  },
  files: [
    'out/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'build/icon.png',
      to: 'app-icon.png',
    },
    {
      from: 'build/trayTemplate.png',
      to: 'trayTemplate.png',
    },
    {
      from: 'build/trayTemplate@2x.png',
      to: 'trayTemplate@2x.png',
    },
  ],
  afterPack: './scripts/apply-fuses.cjs',
  forceCodeSigning: requireSigning,
  publish: {
    provider: 'generic',
    url: `${desktopConfig.updateBaseUrl}/latest/${updatePlatform}/${updateArch}`,
    channel: 'latest',
  },
  artifactName: '${productName}-Desktop-${version}-${os}-${arch}.${ext}',
  mac: {
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: requireSigning,
  },
  dmg: {
    sign: requireSigning,
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'CloudCLI',
    deleteAppDataOnUninstall: false,
  },
};

export default config;
