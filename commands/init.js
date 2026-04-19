const inquirer = require('inquirer');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadConfig, saveConfig, configExists } = require('../lib/config');
const { encrypt } = require('../lib/crypto');

async function initCommand() {
  let config = loadConfig();
  let existingInit = configExists();

  if (existingInit) {
    const { reinit } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'reinit',
        message: 'Already initialized. Re-initialize? This will delete and re-clone your local vault copy.',
        default: false
      }
    ]);

    if (!reinit) {
      console.log('Cancelled.');
      return;
    }

    // Wipe corrupted or stale local clone
    const vaultPath = config.vaultPath;
    if (fs.existsSync(vaultPath)) {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  }

  const { vaultRemote } = await inquirer.prompt([
    {
      type: 'input',
      name: 'vaultRemote',
      message: 'Vault repo remote URL:',
      validate: (input) => {
        if (!input || input.trim() === '') {
          return 'Vault remote URL is required';
        }
        return true;
      }
    }
  ]);

  const { masterPassword } = await inquirer.prompt([
    {
      type: 'password',
      name: 'masterPassword',
      message: 'Master password (never stored):',
      mask: '*',
      validate: (input) => {
        if (!input || input.trim() === '') {
          return 'Master password is required';
        }
        return true;
      }
    }
  ]);

  // Clone vault repo
  const vaultPath = path.join(os.homedir(), '.repo-parking', 'vault');

  // Ensure parent directory exists
  const vaultParent = path.dirname(vaultPath);
  if (!fs.existsSync(vaultParent)) {
    fs.mkdirSync(vaultParent, { recursive: true });
  }

  console.log('Cloning vault repository...');

  // Detect the default branch before cloning
  let vaultBranch = 'main';
  try {
    const remoteInfo = await simpleGit().listRemote([vaultRemote, '--symref']);
    const match = remoteInfo.match(/^ref: refs\/heads\/(\S+)\tHEAD/m);
    if (match) {
      vaultBranch = match[1];
    }
  } catch (err) {
    // Fall back to 'main'
  }

  await simpleGit().clone(vaultRemote, vaultPath);

  // P2-z fix: after re-clone, switch to the configured vaultBranch
  await simpleGit(vaultPath).checkout([vaultBranch]);

  // Create projects directory and meta.json if needed
  const projectsDir = path.join(vaultPath, 'projects');
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  const metaPath = path.join(vaultPath, 'meta.json');
  let metaCreated = false;
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({ retiredIds: [] }, null, 2));
    metaCreated = true;
  }

  // If any files were created, stage and commit BEFORE pushing
  if (metaCreated || !fs.existsSync(path.join(vaultPath, '.git', 'refs', 'heads', vaultBranch))) {
    const git = simpleGit(vaultPath);
    await git.add('-A');
    const status = await git.status();
    if (status.files.length > 0) {
      await git.commit('init: bootstrap vault');
    }

    // P1-u fix: check isFirstCommit for rollback
    try {
      const commitCount = await git.revList(['--count', 'HEAD']);
      const isFirstCommit = commitCount === '1';

      try {
        await git.push(['--set-upstream', 'origin', vaultBranch]);
      } catch (pushErr) {
        if (isFirstCommit) {
          const emptyTreeSha = await git.mktree(['-t', 'tree']);
          const branchName = await git.branchLocal().current;
          await git.updateRef(['-d', `refs/heads/${branchName}`]);
          await git.reset([emptyTreeSha]);
        } else {
          await git.reset(['--hard', 'HEAD~1']);
        }
        throw new Error('Push failed');
      }
    } catch (err) {
      console.error('Failed to push to vault:', err.message);
      return;
    }
  }

  // Save config
  const newConfig = {
    vaultRemote: vaultRemote,
    vaultPath: vaultPath,
    vaultBranch: vaultBranch
  };
  saveConfig(newConfig);

  console.log('\x1b[33m\x1b[1m⚠ Your master password cannot be recovered. Store it safely — it is never saved anywhere.\x1b[0m');
  console.log('Initialized successfully.');
}

module.exports = initCommand;
