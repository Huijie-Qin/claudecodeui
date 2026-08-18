import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DESKTOP_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SCRIPT = join(DESKTOP_DIRECTORY, 'scripts/publish-update-stage.sh');

interface FixtureFile {
  name: string;
  contents: string;
}

function metadata(version: string, filename: string): string {
  return `version: ${version}\nfiles:\n  - url: ${filename}\npath: ${filename}\n`;
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function createStage(
  updateRoot: string,
  deployId: string,
  version: string,
  overrides: Partial<Record<string, string>> = {},
): Promise<void> {
  const macDirectory = join(updateRoot, '.staging', deployId, 'latest/mac/universal');
  const winDirectory = join(updateRoot, '.staging', deployId, 'latest/win/x64');
  await Promise.all([
    mkdir(macDirectory, { recursive: true }),
    mkdir(winDirectory, { recursive: true }),
  ]);

  const macZip = `CloudCLI-Desktop-${version}-mac-universal.zip`;
  const macDmg = `CloudCLI-Desktop-${version}-mac-universal.dmg`;
  const winExe = `CloudCLI-Desktop-${version}-win-x64.exe`;
  const macFiles: FixtureFile[] = [
    { name: macZip, contents: overrides[macZip] ?? `mac zip ${version}` },
    { name: `${macZip}.blockmap`, contents: `mac zip blockmap ${version}` },
    { name: macDmg, contents: `mac dmg ${version}` },
    { name: `${macDmg}.blockmap`, contents: `mac dmg blockmap ${version}` },
    { name: 'latest-mac.yml', contents: metadata(version, macZip) },
  ];
  const winFiles: FixtureFile[] = [
    { name: winExe, contents: `win exe ${version}` },
    { name: `${winExe}.blockmap`, contents: `win blockmap ${version}` },
    { name: 'latest.yml', contents: metadata(version, winExe) },
  ];

  await Promise.all([
    ...macFiles.map((file) => writeFile(join(macDirectory, file.name), file.contents)),
    ...winFiles.map((file) => writeFile(join(winDirectory, file.name), file.contents)),
  ]);
  await Promise.all([
    writeFile(
      join(macDirectory, 'SHA256SUMS'),
      macFiles.map((file) => `${sha256(file.contents)}  ${file.name}\n`).join(''),
    ),
    writeFile(
      join(winDirectory, 'SHA256SUMS'),
      winFiles.map((file) => `${sha256(file.contents)}  ${file.name}\n`).join(''),
    ),
  ]);
}

function publish(updateRoot: string, deployId: string) {
  return spawnSync('bash', [PUBLISH_SCRIPT, updateRoot, deployId], {
    encoding: 'utf8',
  });
}

describe('atomic desktop update publishing', () => {
  it('publishes both platforms only after checksums and removes the staging directory', async () => {
    const updateRoot = await mkdtemp(join(tmpdir(), 'cloudcli-desktop-publish-'));
    await createStage(updateRoot, '100-1', '1.0.0');

    const result = publish(updateRoot, '100-1');
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(
      join(updateRoot, 'latest/mac/universal/latest-mac.yml'),
      'utf8',
    )).toContain('version: 1.0.0');
    expect(await readFile(
      join(updateRoot, 'latest/win/x64/latest.yml'),
      'utf8',
    )).toContain('version: 1.0.0');
    await expect(stat(join(updateRoot, '.staging', '100-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects changed immutable artifacts and version downgrades', async () => {
    const updateRoot = await mkdtemp(join(tmpdir(), 'cloudcli-desktop-publish-'));
    await createStage(updateRoot, '200-1', '1.0.0');
    expect(publish(updateRoot, '200-1').status).toBe(0);

    const zipName = 'CloudCLI-Desktop-1.0.0-mac-universal.zip';
    await createStage(updateRoot, '201-1', '1.0.0', {
      [zipName]: 'different bytes for the same immutable URL',
    });
    const replacement = publish(updateRoot, '201-1');
    expect(replacement.status).toBe(65);
    expect(replacement.stderr).toContain('immutable artifact');
    expect(await readFile(
      join(updateRoot, 'latest/mac/universal', zipName),
      'utf8',
    )).toBe('mac zip 1.0.0');

    await createStage(updateRoot, '202-1', '0.9.0');
    const downgrade = publish(updateRoot, '202-1');
    expect(downgrade.status).toBe(65);
    expect(downgrade.stderr).toContain('refusing to publish desktop version 0.9.0');
  });
});
