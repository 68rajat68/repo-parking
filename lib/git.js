const simpleGit = require('simple-git');

function isGitRepo() {
  try {
    simpleGit().raw(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch (err) {
    return false;
  }
}

function hasCommits() {
  try {
    simpleGit().log({ maxCount: 1 });
    return true;
  } catch (err) {
    return false;
  }
}

function getRepoRoot() {
  return simpleGit().raw(['rev-parse', '--show-toplevel']).then(r => r.trim()).catch(() => null);
}

async function getUpstreamInfo(repoRoot) {
  const git = simpleGit(repoRoot);

  // Check for detached HEAD state
  let branchName;
  try {
    const result = await git.raw(['symbolic-ref', '--short', 'HEAD']);
    branchName = result.trim();
  } catch (err) {
    try {
      const result = await git.raw(['rev-parse', '--abbrev-ref', 'HEAD']);
      branchName = result.trim();
    } catch (err2) {
      throw new Error('Cannot park in detached HEAD state. Check out a branch first.');
    }
  }

  if (branchName === 'HEAD') {
    throw new Error('Cannot park a repo in detached HEAD state. Check out a branch first.');
  }

  let remoteName;
  let trackingBranch;
  let remoteUrl;
  let remotePushUrl;
  let hasUpstream = false;

  // Check for configured upstream
  try {
    const upstreamRef = (await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    if (upstreamRef) {
      const parts = upstreamRef.split('/');
      remoteName = parts[0];
      trackingBranch = parts.slice(1).join('/');
      hasUpstream = true;

      remoteUrl = (await git.raw(['remote', 'get-url', remoteName])).trim();

      try {
        remotePushUrl = (await git.raw(['config', 'remote.' + remoteName + '.pushurl'])).trim();
        if (remotePushUrl === '') {
          remotePushUrl = undefined;
        }
      } catch (err) {
        remotePushUrl = undefined;
      }

      // Check for embedded credentials
      if (/^https?:\/\/[^@]+@/i.test(remoteUrl)) {
        throw new Error(
          'Remote URL contains embedded credentials. Use SSH or a token URL without username.'
        );
      }
      if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
        throw new Error(
          'Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.'
        );
      }

      return { remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream };
    }
  } catch (err) {
    // No upstream configured
  }

  // No upstream - list all remotes
  try {
    const remotesResult = await git.raw(['remote']);
    const remotes = remotesResult.split('\n').filter(r => r.trim() !== '');
    const uniqueRemotes = [...new Set(remotes)];

    if (uniqueRemotes.length === 0) {
      throw new Error('No remotes configured. Add a remote and push at least once before parking.');
    }

    if (uniqueRemotes.length === 1) {
      remoteName = uniqueRemotes[0];
    } else {
      // Caller will handle prompting user to pick
      return {
        remoteName: null,
        trackingBranch: branchName,
        remoteUrl: null,
        remotePushUrl: undefined,
        hasUpstream: false,
        availableRemotes: uniqueRemotes
      };
    }

    remoteUrl = (await git.raw(['remote', 'get-url', remoteName])).trim();

    try {
      remotePushUrl = (await git.raw(['config', 'remote.' + remoteName + '.pushurl'])).trim();
      if (remotePushUrl === '') {
        remotePushUrl = undefined;
      }
    } catch (err) {
      remotePushUrl = undefined;
    }

    // Check for embedded credentials
    if (/^https?:\/\/[^@]+@/i.test(remoteUrl)) {
      throw new Error(
        'Remote URL contains embedded credentials. Use SSH or a token URL without username.'
      );
    }
    if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
      throw new Error(
        'Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.'
      );
    }

    return { remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream };
  } catch (err) {
    throw err;
  }
}

function parsePorcelainLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed;
}

function getUncommittedFiles(repoRoot) {
  try {
    const result = simpleGit(repoRoot).status(['--porcelain=v1']);
    return result.files.filter(line => {
      const parsed = parsePorcelainLine(line);
      return parsed !== null;
    });
  } catch (err) {
    return [];
  }
}

function getUnpushedCommits(remoteName, trackingBranch, hasUpstream, repoRoot) {
  try {
    if (!hasUpstream) {
      const result = simpleGit(repoRoot).log({ maxCount: undefined });
      return result.all.map(c => c.hash + ' ' + c.message);
    }

    try {
      const result = simpleGit(repoRoot).log([remoteName + '/' + trackingBranch + '..HEAD']);
      return result.stdout.split('\n').filter(line => line.trim() !== '');
    } catch (err) {
      const result = simpleGit(repoRoot).log({ maxCount: undefined });
      return result.all.map(c => c.hash + ' ' + c.message);
    }
  } catch (err) {
    return [];
  }
}

function commitAndPush(message, remoteName, trackingBranch, hasUpstream, repoRoot) {
  const git = simpleGit(repoRoot);
  try {
    git.add('.');

    const status = git.status();
    if (status.files.length === 0) {
      return pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot);
    }

    git.commit(message);

    if (hasUpstream) {
      git.push();
    } else {
      git.push(['--set-upstream', remoteName, trackingBranch]);
    }
    return true;
  } catch (err) {
    return false;
  }
}

function pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot) {
  const git = simpleGit(repoRoot);
  try {
    if (hasUpstream) {
      git.push();
    } else {
      git.push(['--set-upstream', remoteName, trackingBranch]);
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function cloneRepo(remoteUrl, targetPath) {
  try {
    await simpleGit().clone(remoteUrl, targetPath, ['--progress']);
    return true;
  } catch (err) {
    return false;
  }
}

async function getAllBranchesWithUnpushed(repoRoot) {
  const results = [];

  // Step 1: get all local branch names
  let branchNames = [];
  try {
    const output = await simpleGit(repoRoot).raw(['branch', '--format=%(refname:short)']);
    branchNames = output.split('\n').map(b => b.trim()).filter(b => b !== '');
  } catch (err) {
    return results;
  }

  // Step 2: for each branch, count unpushed commits
  for (const branchName of branchNames) {
    try {
      let count = 0;
      try {
        // Try to compare with origin/<branchName>
        const logOutput = await simpleGit(repoRoot).raw([
          'log', 'origin/' + branchName + '...' + branchName, '--oneline'
        ]);
        count = logOutput.split('\n').filter(line => line.trim() !== '').length;
      } catch (err) {
        // Branch never pushed - all commits are unpushed
        const logOutput = await simpleGit(repoRoot).raw(['log', branchName, '--oneline']);
        count = logOutput.split('\n').filter(line => line.trim() !== '').length;
      }

      if (count > 0) {
        results.push({ branchName, unpushedCount: count });
      }
    } catch (err) {
      // Skip this branch if check fails
      continue;
    }
  }

  // Step 3: return results
  return results;
}

module.exports = {
  isGitRepo,
  hasCommits,
  getRepoRoot,
  getUpstreamInfo,
  getUncommittedFiles,
  getUnpushedCommits,
  commitAndPush,
  pushOnly,
  cloneRepo,
  getAllBranchesWithUnpushed
};
