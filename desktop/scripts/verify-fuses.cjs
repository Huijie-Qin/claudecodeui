'use strict';

const path = require('node:path');

async function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    throw new Error('Usage: npm run verify:fuses -- <path-to-app-or-executable>');
  }

  const {
    FuseState,
    FuseV1Options,
    FuseVersion,
    getCurrentFuseWire,
  } = await import('@electron/fuses');
  // npm preserves the directory from which the script was invoked in INIT_CWD.
  // This keeps paths intuitive when called through `npm --prefix desktop`.
  const invocationDirectory = process.env.INIT_CWD || process.cwd();
  const fuseWire = await getCurrentFuseWire(path.resolve(invocationDirectory, appPath));
  if (fuseWire.version !== FuseVersion.V1) {
    throw new Error(`Unsupported fuse version: ${fuseWire.version}`);
  }

  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ]);

  for (const [option, expectedState] of expected) {
    const actualState = fuseWire[option];
    if (actualState !== expectedState) {
      throw new Error(
        `${FuseV1Options[option]} has state ${FuseState[actualState]}, expected ${FuseState[expectedState]}.`,
      );
    }
  }

  console.log(`Verified Electron fuses for ${appPath}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
