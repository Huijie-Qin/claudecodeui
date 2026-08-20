'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NATIVE_MODULES = Object.freeze(['better-sqlite3', 'bcrypt', 'node-pty']);
const ARCH_NAMES = Object.freeze({
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
});
const PE_SIGNATURE = 0x00004550;
const PE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x020b;
const PE_CHARACTERISTIC_EXECUTABLE_IMAGE = 0x0002;
const PE_CHARACTERISTIC_DLL = 0x2000;
const WINDOWS_X64_PREBUILDS = Object.freeze([
  Object.freeze({
    moduleName: 'better-sqlite3',
    source: ['prebuilds', 'win32-x64.node'],
    destination: null,
    kind: 'dll',
    label: 'better-sqlite3 binding',
  }),
  Object.freeze({
    moduleName: 'bcrypt',
    source: ['prebuilds', 'win32-x64', 'bcrypt.node'],
    destination: ['build', 'Release', 'bcrypt_lib.node'],
    kind: 'dll',
    label: 'bcrypt binding',
  }),
  Object.freeze({
    moduleName: 'node-pty',
    source: ['prebuilds', 'win32-x64', 'conpty.node'],
    destination: ['build', 'Release', 'conpty.node'],
    kind: 'dll',
    label: 'node-pty ConPTY binding',
  }),
  Object.freeze({
    moduleName: 'node-pty',
    source: ['prebuilds', 'win32-x64', 'conpty_console_list.node'],
    destination: ['build', 'Release', 'conpty_console_list.node'],
    kind: 'dll',
    label: 'node-pty console-list helper',
  }),
  Object.freeze({
    moduleName: 'node-pty',
    source: ['prebuilds', 'win32-x64', 'conpty', 'conpty.dll'],
    destination: ['build', 'Release', 'conpty', 'conpty.dll'],
    kind: 'dll',
    label: 'node-pty conpty.dll',
  }),
  Object.freeze({
    moduleName: 'node-pty',
    source: ['prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe'],
    destination: ['build', 'Release', 'conpty', 'OpenConsole.exe'],
    kind: 'exe',
    label: 'node-pty OpenConsole.exe',
  }),
]);

function archName(arch) {
  if (typeof arch === 'string') {
    return arch;
  }
  const name = ARCH_NAMES[arch];
  if (!name) {
    throw new Error(`Unsupported Electron Builder architecture: ${arch}.`);
  }
  return name;
}

function packagedRuntimeDirectory(context) {
  const productName = context.packager.appInfo.productFilename;
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources', 'runtime')
    : path.join(context.appOutDir, 'resources', 'runtime');
}

function assertNativeModules(runtimeDirectory) {
  for (const moduleName of NATIVE_MODULES) {
    const packageJson = path.join(runtimeDirectory, 'node_modules', moduleName, 'package.json');
    if (!fs.existsSync(packageJson)) {
      throw new Error(`Desktop runtime is missing native dependency ${moduleName}.`);
    }
  }
}

function assertPeX64(filePath, { kind = 'dll', label = path.basename(filePath) } = {}) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Desktop runtime is missing official Windows x64 ${label}: ${filePath}.`);
  }

  const contents = fs.readFileSync(filePath);
  if (contents.length < 0x40 || contents.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Desktop Windows x64 ${label} is not a valid PE image (missing MZ header).`);
  }
  const peOffset = contents.readUInt32LE(0x3c);
  const coffEnd = peOffset + 24;
  if (peOffset < 0x40 || coffEnd > contents.length) {
    throw new Error(`Desktop Windows x64 ${label} has an invalid PE header offset.`);
  }
  if (contents.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error(`Desktop Windows x64 ${label} is not a valid PE image (missing PE signature).`);
  }
  if (contents.readUInt16LE(peOffset + 4) !== PE_MACHINE_AMD64) {
    throw new Error(`Desktop Windows x64 ${label} is not an AMD64 PE image.`);
  }

  const numberOfSections = contents.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = contents.readUInt16LE(peOffset + 20);
  if (
    numberOfSections < 1
    || optionalHeaderSize < 0x70
    || coffEnd + optionalHeaderSize > contents.length
    || coffEnd + optionalHeaderSize + (numberOfSections * 40) > contents.length
    || contents.readUInt16LE(coffEnd) !== PE32_PLUS_MAGIC
  ) {
    throw new Error(`Desktop Windows x64 ${label} has an invalid PE32+ image layout.`);
  }

  const characteristics = contents.readUInt16LE(peOffset + 22);
  if ((characteristics & PE_CHARACTERISTIC_EXECUTABLE_IMAGE) === 0) {
    throw new Error(`Desktop Windows x64 ${label} is not marked executable.`);
  }
  const isDll = (characteristics & PE_CHARACTERISTIC_DLL) !== 0;
  if ((kind === 'dll' && !isDll) || (kind === 'exe' && isDll)) {
    throw new Error(`Desktop Windows x64 ${label} has the wrong PE image type.`);
  }
}

function resolveWindowsX64Prebuilds(runtimeDirectory) {
  return WINDOWS_X64_PREBUILDS.map((entry) => {
    const moduleDirectory = path.join(
      runtimeDirectory,
      'node_modules',
      entry.moduleName,
    );
    return {
      ...entry,
      sourcePath: path.join(moduleDirectory, ...entry.source),
      destinationPath: entry.destination
        ? path.join(moduleDirectory, ...entry.destination)
        : null,
    };
  });
}

function assertWindowsX64Runtime(runtimeDirectory) {
  for (const entry of resolveWindowsX64Prebuilds(runtimeDirectory)) {
    assertPeX64(entry.destinationPath ?? entry.sourcePath, entry);
  }
}

function prepareWindowsX64Prebuilds(runtimeDirectory) {
  assertNativeModules(runtimeDirectory);
  const prebuilds = resolveWindowsX64Prebuilds(runtimeDirectory);

  // Validate the complete official package payload before touching an existing
  // staging build. A corrupt or incomplete package must not leave a partial
  // build/Release tree that can be mistaken for a usable Windows runtime.
  for (const entry of prebuilds) {
    assertPeX64(entry.sourcePath, entry);
  }

  for (const moduleName of NATIVE_MODULES) {
    const moduleDirectory = path.join(runtimeDirectory, 'node_modules', moduleName);
    fs.rmSync(path.join(moduleDirectory, 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDirectory, 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(moduleDirectory, 'node-addon-api'), {
      recursive: true,
      force: true,
    });
  }

  for (const entry of prebuilds) {
    if (!entry.destinationPath) {
      continue;
    }
    fs.mkdirSync(path.dirname(entry.destinationPath), { recursive: true });
    fs.copyFileSync(entry.sourcePath, entry.destinationPath);
  }
  assertWindowsX64Runtime(runtimeDirectory);
}

function shouldUseWindowsX64Prebuilds(platform, arch) {
  return platform === 'win32' && arch === 'x64';
}

function collectRuntimeReleaseFiles(directory, moduleName) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.node'))
    .map((entry) => path.join(directory, entry.name));
  if (moduleName !== 'node-pty') {
    return files;
  }
  for (const relativePath of [
    'spawn-helper',
    path.join('conpty', 'conpty.dll'),
    path.join('conpty', 'OpenConsole.exe'),
  ]) {
    const helper = path.join(directory, relativePath);
    if (fs.existsSync(helper) && fs.statSync(helper).isFile()) {
      files.push(helper);
    }
  }
  return files;
}

function ensureNodePtyHelpers(moduleDirectory, releaseDirectory, platform, arch) {
  if (platform === 'darwin') {
    const helper = path.join(releaseDirectory, 'spawn-helper');
    if (!fs.existsSync(helper)) {
      const prebuiltHelper = path.join(
        moduleDirectory,
        'prebuilds',
        `darwin-${arch}`,
        'spawn-helper',
      );
      if (!fs.existsSync(prebuiltHelper)) {
        throw new Error('Electron rebuild did not produce the node-pty spawn-helper.');
      }
      fs.copyFileSync(prebuiltHelper, helper);
      fs.chmodSync(helper, 0o755);
    }
  }
  if (platform === 'win32') {
    const conptyDirectory = path.join(releaseDirectory, 'conpty');
    for (const filename of ['conpty.dll', 'OpenConsole.exe']) {
      const destination = path.join(conptyDirectory, filename);
      if (!fs.existsSync(destination)) {
        const source = path.join(
          moduleDirectory,
          'prebuilds',
          `win32-${arch}`,
          'conpty',
          filename,
        );
        if (!fs.existsSync(source)) {
          throw new Error(`Desktop node-pty runtime is missing ${filename}.`);
        }
        fs.mkdirSync(conptyDirectory, { recursive: true });
        fs.copyFileSync(source, destination);
      }
    }
  }
}

function pruneNativeBuildArtifacts(
  runtimeDirectory,
  platform = process.platform,
  arch = process.arch,
) {
  for (const moduleName of NATIVE_MODULES) {
    const moduleDirectory = path.join(runtimeDirectory, 'node_modules', moduleName);
    const buildDirectory = path.join(moduleDirectory, 'build');
    const generatedBinDirectory = path.join(moduleDirectory, 'bin');
    // node-gyp materializes architecture-specific make fragments here while
    // rebuilding bcrypt. They are build-only and make Universal staging apps
    // differ even after build/ itself has been pruned.
    fs.rmSync(path.join(moduleDirectory, 'node-addon-api'), {
      recursive: true,
      force: true,
    });

    if (moduleName === 'better-sqlite3') {
      // v13 ships N-API prebuilds selected directly by its loader.
      fs.rmSync(buildDirectory, { recursive: true, force: true });
      fs.rmSync(generatedBinDirectory, { recursive: true, force: true });
      continue;
    }

    const releaseDirectory = path.join(buildDirectory, 'Release');
    if (moduleName === 'node-pty') {
      ensureNodePtyHelpers(moduleDirectory, releaseDirectory, platform, arch);
    }
    const runtimeFiles = collectRuntimeReleaseFiles(releaseDirectory, moduleName);
    const bindingNames = runtimeFiles
      .filter((filePath) => filePath.endsWith('.node'))
      .map((filePath) => path.basename(filePath));
    if (bindingNames.length === 0) {
      throw new Error(`Electron rebuild did not produce a Release binding for ${moduleName}.`);
    }
    if (new Set(bindingNames).size !== bindingNames.length) {
      throw new Error(`Electron rebuild produced duplicate binding names for ${moduleName}.`);
    }
    if (moduleName === 'node-pty' && platform === 'win32') {
      for (const requiredBinding of ['conpty.node', 'conpty_console_list.node']) {
        if (!bindingNames.includes(requiredBinding)) {
          throw new Error(`Electron rebuild did not produce node-pty ${requiredBinding}.`);
        }
      }
    }
    const preserved = runtimeFiles.map((filePath) => ({
      relativePath: path.relative(releaseDirectory, filePath),
      contents: fs.readFileSync(filePath),
      mode: fs.statSync(filePath).mode,
    }));

    fs.rmSync(buildDirectory, { recursive: true, force: true });
    fs.mkdirSync(releaseDirectory, { recursive: true });
    for (const runtimeFile of preserved) {
      const destination = path.join(releaseDirectory, runtimeFile.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, runtimeFile.contents, {
        mode: runtimeFile.mode,
      });
    }
    // @electron/rebuild caches a target-specific copy under bin/<platform>-<arch>-<abi>.
    // Keeping it would make the x64 and arm64 staging apps have different Mach-O sets.
    fs.rmSync(generatedBinDirectory, { recursive: true, force: true });
  }

  if (platform === 'win32' && arch === 'x64') {
    assertWindowsX64Runtime(runtimeDirectory);
  }
}

async function rebuildRuntimeDirectory({
  runtimeDirectory,
  platform,
  arch,
  electronVersion,
  nativeRebuild,
}) {
  assertNativeModules(runtimeDirectory);
  const targetArch = archName(arch);
  if (targetArch === 'universal') {
    return;
  }
  if (shouldUseWindowsX64Prebuilds(platform, targetArch)) {
    prepareWindowsX64Prebuilds(runtimeDirectory);
    return;
  }

  const rebuild = nativeRebuild ?? (await import('@electron/rebuild')).rebuild;
  await rebuild({
    buildPath: runtimeDirectory,
    electronVersion,
    platform,
    arch: targetArch,
    onlyModules: [...NATIVE_MODULES],
    force: true,
    mode: 'sequential',
  });
  pruneNativeBuildArtifacts(runtimeDirectory, platform, targetArch);
}

async function rebuildPackagedRuntime(context) {
  const runtimeDirectory = packagedRuntimeDirectory(context);
  await rebuildRuntimeDirectory({
    runtimeDirectory,
    platform: context.electronPlatformName,
    arch: context.arch,
    electronVersion: context.packager.config.electronVersion
      ?? context.packager.info.framework.version,
  });
}

module.exports = rebuildPackagedRuntime;
module.exports.NATIVE_MODULES = NATIVE_MODULES;
module.exports.archName = archName;
module.exports.assertPeX64 = assertPeX64;
module.exports.assertWindowsX64Runtime = assertWindowsX64Runtime;
module.exports.packagedRuntimeDirectory = packagedRuntimeDirectory;
module.exports.prepareWindowsX64Prebuilds = prepareWindowsX64Prebuilds;
module.exports.pruneNativeBuildArtifacts = pruneNativeBuildArtifacts;
module.exports.rebuildRuntimeDirectory = rebuildRuntimeDirectory;
module.exports.shouldUseWindowsX64Prebuilds = shouldUseWindowsX64Prebuilds;

if (require.main === module) {
  const desktopDirectory = path.resolve(__dirname, '..');
  const desktopPackage = require(path.join(desktopDirectory, 'package.json'));
  rebuildRuntimeDirectory({
    runtimeDirectory: path.join(desktopDirectory, '.runtime'),
    platform: process.platform,
    arch: process.arch,
    electronVersion: desktopPackage.devDependencies.electron,
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
