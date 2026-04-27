const simpleGit = require("simple-git");

async function isGitRepo(cwd = process.cwd()) {
  try {
    const out = await simpleGit(cwd).raw(["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch (err) {
    return false;
  }
}

async function hasCommits(cwd = process.cwd()) {
  try {
    const log = await simpleGit(cwd).log({ maxCount: 1 });
    return log.total > 0;
  } catch (err) {
    return false;
  }
}

function getRepoRoot() {
  return simpleGit()
    .raw(["rev-parse", "--show-toplevel"])
    .then((r) => r.trim())
    .catch(() => null);
}

async function getUpstreamInfo(repoRoot) {
  const git = simpleGit(repoRoot);

  // Check for detached HEAD state
  let branchName;
  try {
    const result = await git.raw(["symbolic-ref", "--short", "HEAD"]);
    branchName = result.trim();
  } catch (err) {
    try {
      const result = await git.raw(["rev-parse", "--abbrev-ref", "HEAD"]);
      branchName = result.trim();
    } catch (err2) {
      throw new Error(
        "Cannot park in detached HEAD state. Check out a branch first.",
      );
    }
  }

  if (branchName === "HEAD") {
    throw new Error(
      "Cannot park a repo in detached HEAD state. Check out a branch first.",
    );
  }

  let remoteName;
  let trackingBranch;
  let remoteUrl;
  let remotePushUrl;
  let hasUpstream = false;

  // Check for configured upstream
  try {
    const upstreamRef = (
      await git.raw([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ])
    ).trim();
    if (upstreamRef) {
      const parts = upstreamRef.split("/");
      remoteName = parts[0];
      trackingBranch = parts.slice(1).join("/");
      hasUpstream = true;

      remoteUrl = (await git.raw(["remote", "get-url", remoteName])).trim();

      try {
        remotePushUrl = (
          await git.raw(["config", "remote." + remoteName + ".pushurl"])
        ).trim();
        if (remotePushUrl === "") {
          remotePushUrl = undefined;
        }
      } catch (err) {
        remotePushUrl = undefined;
      }

      // Check for embedded credentials
      if (/^https?:\/\/[^@]+@/i.test(remoteUrl)) {
        throw new Error(
          "Remote URL contains embedded credentials. Use SSH or a token URL without username.",
        );
      }
      if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
        throw new Error(
          "Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.",
        );
      }

      return {
        remoteName,
        trackingBranch,
        remoteUrl,
        remotePushUrl,
        hasUpstream,
      };
    }
  } catch (err) {
    // No upstream configured
  }

  // No upstream - list all remotes
  try {
    const remotesResult = await git.raw(["remote"]);
    const remotes = remotesResult.split("\n").filter((r) => r.trim() !== "");
    const uniqueRemotes = [...new Set(remotes)];

    if (uniqueRemotes.length === 0) {
      throw new Error(
        "No remotes configured. Add a remote and push at least once before parking.",
      );
    }

    if (uniqueRemotes.length > 1) {
      // Caller will handle prompting user to pick
      return {
        remoteName: null,
        trackingBranch: branchName,
        remoteUrl: null,
        remotePushUrl: undefined,
        hasUpstream: false,
        availableRemotes: uniqueRemotes,
      };
    }

    remoteName = uniqueRemotes[0];

    remoteUrl = (await git.raw(["remote", "get-url", remoteName])).trim();

    try {
      remotePushUrl = (
        await git.raw(["config", "remote." + remoteName + ".pushurl"])
      ).trim();
      if (remotePushUrl === "") {
        remotePushUrl = undefined;
      }
    } catch (err) {
      remotePushUrl = undefined;
    }

    trackingBranch = branchName;

    // Check for embedded credentials
    if (/^https?:\/\/[^@]+@/i.test(remoteUrl)) {
      throw new Error(
        "Remote URL contains embedded credentials. Use SSH or a token URL without username.",
      );
    }
    if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
      throw new Error(
        "Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.",
      );
    }

    return {
      remoteName,
      trackingBranch,
      remoteUrl,
      remotePushUrl,
      hasUpstream,
    };
  } catch (err) {
    throw err;
  }
}

async function getUncommittedFiles(repoRoot) {
  try {
    const result = await simpleGit(repoRoot).status();
    return result.files || [];
  } catch (err) {
    return [];
  }
}

async function getUnpushedCommits(
  remoteName,
  trackingBranch,
  hasUpstream,
  repoRoot,
) {
  const git = simpleGit(repoRoot);
  const range = remoteName + "/" + trackingBranch + "..HEAD";

  try {
    if (!hasUpstream) {
      try {
        const out = await git.raw(["log", range, "--oneline"]);
        const lines = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        return lines;
      } catch (err) {
        const log = await git.log({ maxCount: undefined });
        return log.all.map((c) => c.hash + " " + c.message);
      }
    }

    try {
      const out = await git.raw(["log", range, "--oneline"]);
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (err) {
      const log = await git.log({ maxCount: undefined });
      return log.all.map((c) => c.hash + " " + c.message);
    }
  } catch (err) {
    return [];
  }
}

async function commitAndPush(
  message,
  remoteName,
  trackingBranch,
  hasUpstream,
  repoRoot,
) {
  const git = simpleGit(repoRoot);
  try {
    await git.add(".");

    const status = await git.status();
    if (status.files.length === 0) {
      return await pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot);
    }

    await git.commit(message);

    if (hasUpstream) {
      await git.push();
    } else {
      await git.push(["--set-upstream", remoteName, trackingBranch]);
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot) {
  const git = simpleGit(repoRoot);
  try {
    if (hasUpstream) {
      await git.push();
    } else {
      await git.push(["--set-upstream", remoteName, trackingBranch]);
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function cloneRepo(remoteUrl, targetPath) {
  try {
    await simpleGit().clone(remoteUrl, targetPath, ["--progress"]);
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
    const output = await simpleGit(repoRoot).raw([
      "branch",
      "--format=%(refname:short)",
    ]);
    branchNames = output
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b !== "");
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
          "log",
          "origin/" + branchName + "..." + branchName,
          "--oneline",
        ]);
        count = logOutput
          .split("\n")
          .filter((line) => line.trim() !== "").length;
      } catch (err) {
        // Branch never pushed - all commits are unpushed
        const logOutput = await simpleGit(repoRoot).raw([
          "log",
          branchName,
          "--oneline",
        ]);
        count = logOutput
          .split("\n")
          .filter((line) => line.trim() !== "").length;
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
  getAllBranchesWithUnpushed,
};
