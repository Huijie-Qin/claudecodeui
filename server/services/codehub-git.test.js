import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codeHubGitService } from './codehub-git.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('lists commits against the upstream project when source and target branches have the same name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codehub-submission-'));
  try {
    const upstreamRepo = path.join(root, 'upstream.git');
    const personalRepo = path.join(root, 'personal.git');
    const worktree = path.join(root, 'worktree');

    git(root, 'init', '--bare', upstreamRepo);
    git(root, 'init', '--bare', personalRepo);
    git(root, 'clone', upstreamRepo, worktree);
    git(worktree, 'config', 'user.email', 'codehub-test@example.com');
    git(worktree, 'config', 'user.name', 'CodeHub Test');
    git(worktree, 'checkout', '-b', 'a');
    git(worktree, 'commit', '--allow-empty', '-m', 'upstream base');
    git(worktree, 'push', 'origin', 'a');
    git(worktree, 'remote', 'rename', 'origin', 'upstream-seed');
    git(worktree, 'remote', 'add', 'origin', personalRepo);
    git(worktree, 'push', 'origin', 'a');
    git(worktree, 'push', 'origin', 'HEAD:refs/heads/develop');
    git(worktree, 'commit', '--allow-empty', '-m', 'personal change');
    git(worktree, 'push', 'origin', 'a');
    const personalSourceSha = git(worktree, 'rev-parse', 'HEAD');

    const personalResult = await codeHubGitService.listSubmissionCommits(worktree, {
      targetBranch: 'a',
      repositoryUrl: personalRepo,
    });
    assert.equal(personalResult.commits.length, 0);

    const upstreamResult = await codeHubGitService.listSubmissionCommits(worktree, {
      targetBranch: 'a',
      mrTargetRepository: 'upstream',
      repositoryUrl: personalRepo,
      publicRepositoryUrl: upstreamRepo,
    });
    assert.equal(upstreamResult.commits.length, 1);
    assert.equal(upstreamResult.commits[0].commitMessage, 'personal change');
    assert.deepEqual(upstreamResult.remoteBranchesAtHead, ['a']);

    git(worktree, 'checkout', '-b', 'local-only');
    git(worktree, 'commit', '--allow-empty', '-m', 'not pushed');
    const localOnlySha = git(worktree, 'rev-parse', 'HEAD');

    const remoteUpstreamResult = await codeHubGitService.listSubmissionCommits(worktree, {
      sourceBranch: 'a',
      targetBranch: 'a',
      mrTargetRepository: 'upstream',
      repositoryUrl: personalRepo,
      publicRepositoryUrl: upstreamRepo,
    });
    assert.equal(remoteUpstreamResult.sourceSha, personalSourceSha);
    assert.notEqual(remoteUpstreamResult.sourceSha, localOnlySha);
    assert.equal(remoteUpstreamResult.commits.length, 1);
    assert.equal(remoteUpstreamResult.commits[0].commitMessage, 'personal change');

    const remotePersonalResult = await codeHubGitService.listSubmissionCommits(worktree, {
      sourceBranch: 'a',
      targetBranch: 'develop',
      mrTargetRepository: 'personal',
      repositoryUrl: personalRepo,
    });
    assert.equal(remotePersonalResult.sourceSha, personalSourceSha);
    assert.equal(remotePersonalResult.commits.length, 1);
    assert.equal(remotePersonalResult.commits[0].commitMessage, 'personal change');

    const sameBranchResult = await codeHubGitService.listSubmissionCommits(worktree, {
      sourceBranch: 'a',
      targetBranch: 'a',
      mrTargetRepository: 'personal',
      repositoryUrl: personalRepo,
    });
    assert.equal(sameBranchResult.sourceSha, sameBranchResult.targetSha);
    assert.deepEqual(sameBranchResult.commits, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
