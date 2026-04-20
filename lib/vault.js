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

function loadProject(idOrName) {
  const projectsDir = path.join(vaultPath, "projects");
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));

  // If matches ID pattern (all uppercase), look up by id field
  if (/^[A-Z]+$/.test(idOrName)) {
    const filePath = path.join(projectsDir, idOrName + ".json");
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, "utf8");
        return JSON.parse(data);
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  // Otherwise, scan by name
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
  listProjects,
  pushVault,
  vaultPath,
  vaultRemote,
  vaultBranch,
};
