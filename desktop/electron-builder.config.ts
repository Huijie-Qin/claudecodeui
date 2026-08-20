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
    {
      from: '.runtime',
      to: 'runtime',
      filter: [
        '**/*',
        '!node{,/**/*}',
        '!node_modules{,/**/*}',
      ],
    },
    // electron-builder deliberately filters a FileSet root named node_modules.
    // Copy it as its own source so the self-contained backend dependencies are
    // included under the runtime resource instead of being silently omitted.
    {
      from: '.runtime/node_modules',
      to: 'runtime/node_modules',
      filter: ['**/*'],
    },
    // npm is copied from the official Node distribution and has its own
    // nested node_modules tree. Keep that tree intact as desktop tooling.
    {
      from: '.runtime/node',
      to: 'runtime/node',
      filter: ['**/*'],
    },
  ],
  afterPack: './scripts/after-pack.cjs',
  forceCodeSigning: requireSigning,
  publish: {
    provider: 'generic',
    url: `${desktopConfig.updateBaseUrl}/latest/${updatePlatform}/${updateArch}`,
    channel: 'latest',
  },
  artifactName: '${productName}-Desktop-${version}-${os}-${arch}.${ext}',
  mac: {
    // A local package without a Developer ID must still be ad-hoc signed after
    // Universal merging and fuse changes, otherwise macOS kills Electron when a
    // lazily faulted code page no longer matches the upstream embedded signature.
    identity: requireSigning ? undefined : '-',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: requireSigning,
    // Both single-architecture staging apps intentionally contain identical
    // binaries under architecture-qualified paths. Keep those files as-is;
    // any per-architecture build/Release outputs remain outside this pattern
    // so the universal merger combines their x64 and arm64 variants with lipo.
    x64ArchFiles: 'Contents/Resources/runtime/{claude/**,node/**,node_modules/**/prebuilds/**}',
  },
  dmg: {
    sign: requireSigning,
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    // Keep PE resource editing for icons/version metadata, but do not let a
    // developer-machine certificate discovered by electron-builder silently
    // turn an unsigned local build into a potentially blocking sign operation.
    // Release CI opts back in together with forceCodeSigning above.
    signExecutable: requireSigning,
    verifyUpdateCodeSignature: requireSigning,
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
