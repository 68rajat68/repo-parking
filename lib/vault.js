const fs = require("fs");
const path = require("path");
const simpleGit = require("simple-git");
const { loadConfig } = require("./config");
const spinner = require("./spinner");

const config = loadConfig();
const vaultPath = config ? config.vaultPath : null;
const vaultRemote = config ? config.vaultRemote : null;
const vaultBranch = config ? config.vaultBranch : null;

async function ensureVaultExists() {
  if (!vaultPath || !vaultRemote || !vaultBranch) {
    throw new Error("Not initialized");
  }

  const gitDir = path.join(vaultPath, ".git");

  if (!fs.existsSync(vaultPath) || !fs.existsSync(gitDir)) {
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
    spinner.start("Re-cloning vault");
    await simpleGit().clone(vaultRemote, vaultPath);
    await simpleGit(vaultPath).checkout([vaultBranch]);
    spinner.succeed("Vault re-cloned");
    return;
  }

  spinner.start("Pulling latest from vault");
  try {
    await simpleGit(vaultPath).pull();
    spinner.succeed("Vault up to date");
  } catch (err) {
    spinner.fail("Pull failed");
    throw new Error("VAULT_PULL_FAILED: " + err.message);
  }
}

function loadMeta() {
  const metaPath = path.join(vaultPath, "meta.json");
  if (!fs.existsSync(metaPath)) {
    return { retiredIds: [] };
  }
  try {
    const data = fs.readFileSync(metaPath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return { retiredIds: [] };
  }
}

function saveMeta(meta) {
  const metaPath = path.join(vaultPath, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function getBundlesDir() {
  return path.join(vaultPath, "bundles");
}

function ensureBundlesDir() {
  const dir = getBundlesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadProject(idOrName) {
  const projectsDir = path.join(vaultPath, "projects");
  const bundlesDir = getBundlesDir();

  // If matches ID pattern (all uppercase), look up by id field (projects first, then bundles)
  if (/^[A-Z]+$/.test(idOrName)) {
    if (fs.existsSync(projectsDir)) {
      const filePath = path.join(projectsDir, idOrName + ".json");
      if (fs.existsSync(filePath)) {
        try {
          const data = fs.readFileSync(filePath, "utf8");
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      }
    }
    if (fs.existsSync(bundlesDir)) {
      const filePath = path.join(bundlesDir, idOrName + ".json");
      if (fs.existsSync(filePath)) {
        try {
          const data = fs.readFileSync(filePath, "utf8");
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      }
    }
    return null;
  }

  // Otherwise, scan by name (projects first, then bundles)
  if (fs.existsSync(projectsDir)) {
    const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const filePath = path.join(projectsDir, file);
        const data = fs.readFileSync(filePath, "utf8");
        const project = JSON.parse(data);
        if (project.name === idOrName) {
          return project;
        }
      } catch (err) {
        continue;
      }
    }
  }

  if (fs.existsSync(bundlesDir)) {
    const files = fs.readdirSync(bundlesDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const filePath = path.join(bundlesDir, file);
        const data = fs.readFileSync(filePath, "utf8");
        const project = JSON.parse(data);
        if (project.name === idOrName) {
          return project;
        }
      } catch (err) {
        continue;
      }
    }
  }

  return null;
}

function saveProject(id, data) {
  const projectsDir = path.join(vaultPath, "projects");
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  const filePath = path.join(projectsDir, id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function deleteProject(id) {
  const filePath = path.join(vaultPath, "projects", id + ".json");
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveBundle(id, data) {
  ensureBundlesDir();
  const filePath = path.join(getBundlesDir(), id + ".json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function deleteBundle(id) {
  const bundlesDir = getBundlesDir();
  const jsonPath = path.join(bundlesDir, id + ".json");
  if (fs.existsSync(jsonPath)) {
    fs.unlinkSync(jsonPath);
  }
  const bundleDataDir = path.join(bundlesDir, id);
  if (fs.existsSync(bundleDataDir)) {
    fs.rmSync(bundleDataDir, { recursive: true, force: true });
  }
}

function listBundles() {
  const bundlesDir = getBundlesDir();
  if (!fs.existsSync(bundlesDir)) {
    return [];
  }

  const files = fs.readdirSync(bundlesDir).filter((f) => f.endsWith(".json"));
  const bundles = [];

  for (const file of files) {
    try {
      const filePath = path.join(bundlesDir, file);
      const data = fs.readFileSync(filePath, "utf8");
      bundles.push(JSON.parse(data));
    } catch (err) {
      continue;
    }
  }

  bundles.sort((a, b) => {
    const dateA = new Date(a.parked_at || 0);
    const dateB = new Date(b.parked_at || 0);
    return dateB - dateA;
  });

  return bundles;
}

/** Repos + file bundles, sorted by parked_at (newest first). */
function listAllParked() {
  const repos = listProjects().map((p) => ({
    ...p,
    kind: p.kind || "repo",
  }));
  const bundles = listBundles().map((b) => ({
    ...b,
    kind: b.kind || "bundle",
  }));
  const merged = [...repos, ...bundles];
  merged.sort((a, b) => {
    const dateA = new Date(a.parked_at || 0);
    const dateB = new Date(b.parked_at || 0);
    return dateB - dateA;
  });
  return merged;
}

function bundlePayloadPath(id) {
  return path.join(getBundlesDir(), id, "payload.enc");
}

function isBundleEntry(entry) {
  return entry && entry.kind === "bundle";
}

function listProjects() {
  const projectsDir = path.join(vaultPath, "projects");
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
  const projects = [];

  for (const file of files) {
    try {
      const filePath = path.join(projectsDir, file);
      const data = fs.readFileSync(filePath, "utf8");
      projects.push(JSON.parse(data));
    } catch (err) {
      continue;
    }
  }

  // Sort by parked_at descending (most recent first)
  projects.sort((a, b) => {
    const dateA = new Date(a.parked_at || 0);
    const dateB = new Date(b.parked_at || 0);
    return dateB - dateA;
  });

  return projects;
}

async function pushVault(message) {
  const git = simpleGit(vaultPath);
  try {
    await git.add("-A");

    const status = await git.status();
    if (status.files.length === 0) {
      return true;
    }

    await git.commit(message);

    const commitCount = await git.raw(["rev-list", "--count", "HEAD"]);
    const isFirstCommit = commitCount === "1";

    spinner.start("Pushing to vault");
    try {
      await git.push();
      spinner.succeed("Pushed to vault");
      return true;
    } catch (pushErr) {
      spinner.fail("Push failed");
      if (isFirstCommit) {
        const emptyTreeSha = await git.mktree(["-t", "tree"]);
        const branchName = await git.branchLocal().current;
        await git.updateRef(["-d", `refs/heads/${branchName}`]);
        await git.reset([emptyTreeSha]);
      } else {
        await git.reset(["--hard", "HEAD~1"]);
      }
      return false;
    }
  } catch (err) {
    return false;
  }
}

module.exports = {
  ensureVaultExists,
  loadMeta,
  saveMeta,
  loadProject,
  saveProject,
  deleteProject,
  saveBundle,
  deleteBundle,
  listProjects,
  listBundles,
  listAllParked,
  ensureBundlesDir,
  getBundlesDir,
  bundlePayloadPath,
  isBundleEntry,
  pushVault,
  vaultPath,
  vaultRemote,
  vaultBranch,
};
