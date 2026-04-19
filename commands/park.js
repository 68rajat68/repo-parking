const inquirer = require('inquirer');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const { ensureVaultExists, listProjects, loadMeta, saveMeta, saveProject, pushVault } = require('../lib/vault');
const { isGitRepo, hasCommits, getRepoRoot, getUpstreamInfo, getUncommittedFiles, getUnpushedCommits, commitAndPush, pushOnly } = require('../lib/git');
const { parseSshConfig } = require('../lib/ssh');
const { readEnvFile } = require('../lib/env');
const { validateRelativePath, encodeFile, validateFileSizes, getNextLetter } = require('../lib/files');
const { encrypt } = require('../lib/crypto');

function validateProjectName(name) {
  if (!name || name.trim() === '') {
    return { valid: false, error: 'Project name cannot be empty.' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { valid: false, error: 'Project name can only contain letters, numbers, hyphens, and underscores.' };
  }
  if (/^[A-Z]+$/.test(name)) {
    return { valid: false, error: 'Names cannot be all uppercase letters (reserved for IDs). Try: my-API, api-server, etc.' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { valid: false, error: 'Project name cannot contain path separators or dot-segments.' };
  }
  return { valid: true };
}

async function parkCommand(name) {
  // STEP 0 — VALIDATE NAME
  const nameValidation = validateProjectName(name);
  if (!nameValidation.valid) {
    console.error(nameValidation.error);
    return;
  }

  // STEP 1 — RESOLVE REPO ROOT
  if (!isGitRepo()) {
    console.error('Not inside a git repository.');
    return;
  }
  if (!hasCommits()) {
    console.error('No commits yet. Make at least one commit.');
    return;
  }

  const repoRoot = getRepoRoot();

  // STEP 2 — RESOLVE CLONEABLE REMOTE
  let upstreamInfo;
  try {
    upstreamInfo = getUpstreamInfo();
  } catch (err) {
    console.error(err.message);
    return;
  }

  let remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream;

  if (upstreamInfo.availableRemotes) {
    // Multi-remote with no upstream - need to ask user to pick
    const choices = upstreamInfo.availableRemotes.map((r, i) => ({
      name: r,
      value: r
    }));

    const { selectedRemote } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedRemote',
        message: 'Multiple remotes found. Which remote should be used for parking?',
        choices: choices
      }
    ]);

    remoteName = selectedRemote;
    trackingBranch = upstreamInfo.trackingBranch;
    hasUpstream = false;

    const git = simpleGit(repoRoot);
    remoteUrl = git.remoteGetUrl([remoteName]).trim();

    try {
      remotePushUrl = git.config(['remote.' + remoteName + '.pushurl']).trim();
      if (remotePushUrl === '') {
        remotePushUrl = undefined;
      }
    } catch (err) {
      remotePushUrl = undefined;
    }

    // Check for embedded credentials
    if (/^https?:\/\/[^@]+@/i.test(remoteUrl)) {
      console.error('Remote URL contains embedded credentials. Use SSH or a token URL without username.');
      return;
    }
    if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
      console.error('Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.');
      return;
    }
  } else {
    remoteName = upstreamInfo.remoteName;
    trackingBranch = upstreamInfo.trackingBranch;
    remoteUrl = upstreamInfo.remoteUrl;
    remotePushUrl = upstreamInfo.remotePushUrl;
    hasUpstream = upstreamInfo.hasUpstream;
  }

  // STEP 3 — DUPLICATE DETECTION
  try {
    await ensureVaultExists();
  } catch (err) {
    if (err.message.startsWith('VAULT_PULL_FAILED:')) {
      console.error('Could not reach vault. Check your internet connection and try again.');
    } else {
      console.error('Vault error:', err.message);
    }
    return;
  }

  const allProjects = listProjects();
  const nameMatches = allProjects.filter(p => p.name === name);
  const remoteMatches = allProjects.filter(p => p.remote === remoteUrl);
  const duplicates = allProjects.filter(p => p.name === name && p.remote === remoteUrl);

  let existingProject = null;
  let duplicateChoice = 'new';

  if (duplicates.length > 0) {
    existingProject = duplicates[0];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'A project with the same name and remote already exists:',
        choices: [
          { name: 'Overwrite existing entry', value: 'overwrite' },
          { name: 'Create new entry with different name', value: 'new' },
          { name: 'Cancel', value: 'cancel' }
        ]
      }
    ]);

    if (action === 'cancel') {
      console.log('Cancelled.');
      return;
    }
    duplicateChoice = action;
  } else if (nameMatches.length > 0) {
    existingProject = nameMatches[0];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'A project with the same name but different remote exists:',
        choices: [
          { name: 'Create new entry with different name', value: 'new' },
          { name: 'Cancel', value: 'cancel' }
        ]
      }
    ]);

    if (action === 'cancel') {
      console.log('Cancelled.');
      return;
    }
    duplicateChoice = 'new';
  } else if (remoteMatches.length > 0) {
    existingProject = remoteMatches[0];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'This remote is already parked as "' + existingProject.name + '":',
        choices: [
          { name: 'Overwrite existing entry', value: 'overwrite' },
          { name: 'Create new entry with different name', value: 'new' },
          { name: 'Cancel', value: 'cancel' }
        ]
      }
    ]);

    if (action === 'cancel') {
      console.log('Cancelled.');
      return;
    }
    duplicateChoice = action;
  }

  let projectName = name;
  if (duplicateChoice === 'new' && existingProject) {
    // Force user to provide a different name
    const { newName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newName',
        message: 'Enter a different name for this project:',
        validate: (input) => {
          if (!input || input.trim() === '') {
            return 'Project name cannot be empty.';
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
            return 'Project name can only contain letters, numbers, hyphens, and underscores.';
          }
          if (/^[A-Z]+$/.test(input)) {
            return 'Names cannot be all uppercase letters (reserved for IDs). Try: my-API, api-server, etc.';
          }
          const allProjectsNow = listProjects();
          if (allProjectsNow.some(p => p.name === input)) {
            return 'A project with this name already exists.';
          }
          return true;
        }
      }
    ]);
    projectName = newName;
  }

  // STEP 4 — PROMPT MASTER PASSWORD
  const { masterPassword } = await inquirer.prompt([
    {
      type: 'password',
      name: 'masterPassword',
      message: 'Master password:',
      mask: '*'
    }
  ]);

  // Print warning only on first park
  if (allProjects.length === 0) {
    console.log('\x1b[33m⚠ Your master password cannot be recovered. Make sure you remember it.\x1b[0m');
  }

  // STEP 5 — GIT SAFETY CHECK
  const uncommittedFiles = getUncommittedFiles(repoRoot);
  const unpushedCommits = getUnpushedCommits(remoteName, trackingBranch, hasUpstream, repoRoot);

  if (uncommittedFiles.length > 0 && unpushedCommits.length > 0) {
    console.log(uncommittedFiles.length + ' uncommitted file(s), ' + unpushedCommits.length + ' unpushed commit(s)');

    const { gitAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'gitAction',
        message: 'Handle manually or let parking do it?',
        choices: [
          { name: 'Handle manually', value: 'manual' },
          { name: 'Let parking handle it', value: 'auto' }
        ]
      }
    ]);

    if (gitAction === 'manual') {
      console.log('Cancelled. Please commit and push your changes first.');
      return;
    }

    const { commitMessage } = await inquirer.prompt([
      {
        type: 'input',
        name: 'commitMessage',
        message: 'Commit message:'
      }
    ]);

    const commitResult = commitAndPush(commitMessage, remoteName, trackingBranch, hasUpstream, repoRoot);
    if (!commitResult) {
      console.error('Push failed. Aborting.');
      return;
    }
  } else if (unpushedCommits.length > 0) {
    // Clean working tree with unpushed commits
    const pushResult = pushOnly(remoteName, trackingBranch, hasUpstream, repoRoot);
    if (!pushResult) {
      console.error('Push failed. Aborting.');
      return;
    }
  } else if (uncommittedFiles.length > 0) {
    console.log(uncommittedFiles.length + ' uncommitted file(s)');

    const { gitAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'gitAction',
        message: 'Handle manually or let parking do it?',
        choices: [
          { name: 'Handle manually', value: 'manual' },
          { name: 'Let parking handle it', value: 'auto' }
        ]
      }
    ]);

    if (gitAction === 'manual') {
      console.log('Cancelled. Please commit and push your changes first.');
      return;
    }

    const { commitMessage } = await inquirer.prompt([
      {
        type: 'input',
        name: 'commitMessage',
        message: 'Commit message:'
      }
    ]);

    const commitResult = commitAndPush(commitMessage, remoteName, trackingBranch, hasUpstream, repoRoot);
    if (!commitResult) {
      console.error('Push failed. Aborting.');
      return;
    }
  }

  // STEP 6 — PROJECT CONFIGURATION
  let setupCmd = '';
  let extraFiles = [];
  let sshAlias = null;
  let sshKeyPath = null;
  let sshPassphrase = null;
  let sshPassphraseEnc = null;
  let notes = '';

  if (duplicateChoice === 'overwrite' && existingProject) {
    // Show existing values, ask K/U
    console.log('');
    console.log('Existing configuration:');
    console.log('  Setup command: ' + (existingProject.setup_cmd || '(none)'));
    console.log('  SSH alias: ' + (existingProject.ssh_alias || '(none)'));
    console.log('  SSH key: ' + (existingProject.ssh_key_path || '(none)'));
    console.log('  Notes: ' + (existingProject.notes || '(none)'));

    const { keepUpdate } = await inquirer.prompt([
      {
        type: 'list',
        name: 'keepUpdate',
        message: 'Keep existing or update?',
        choices: [
          { name: 'Keep existing', value: 'keep' },
          { name: 'Update', value: 'update' }
        ]
      }
    ]);

    if (keepUpdate === 'keep') {
      setupCmd = existingProject.setup_cmd || '';
      extraFiles = existingProject.extra_files || [];
      sshAlias = existingProject.ssh_alias;
      sshKeyPath = existingProject.ssh_key_path;
      sshPassphraseEnc = existingProject.ssh_passphrase_enc;
      notes = existingProject.notes || '';
    } else {
      // Update - ask all questions
      const configAnswers = await askConfigQuestions();
      setupCmd = configAnswers.setupCmd;
      extraFiles = configAnswers.extraFiles;
      sshAlias = configAnswers.sshAlias;
      sshKeyPath = configAnswers.sshKeyPath;
      sshPassphrase = configAnswers.sshPassphrase;
      notes = configAnswers.notes;
      if (sshPassphrase) {
        sshPassphraseEnc = encrypt(sshPassphrase, masterPassword);
      }
    }
  } else {
    // New project - ask all questions
    const configAnswers = await askConfigQuestions();
    setupCmd = configAnswers.setupCmd;
    extraFiles = configAnswers.extraFiles;
    sshAlias = configAnswers.sshAlias;
    sshKeyPath = configAnswers.sshKeyPath;
    sshPassphrase = configAnswers.sshPassphrase;
    notes = configAnswers.notes;
    if (sshPassphrase) {
      sshPassphraseEnc = encrypt(sshPassphrase, masterPassword);
    }
  }

  // STEP 7 — SNAPSHOT + LETTER ASSIGNMENT
  const envRaw = readEnvFile(repoRoot);
  const envEnc = envRaw ? encrypt(envRaw.toString('base64'), masterPassword) : null;

  // Read extra files
  const extraFilesData = [];
  for (const file of extraFiles) {
    const fullPath = path.join(repoRoot, file.path);
    if (fs.existsSync(fullPath)) {
      const fileBuffer = fs.readFileSync(fullPath);
      const fileB64 = fileBuffer.toString('base64');
      const fileEnc = encrypt(fileB64, masterPassword);
      extraFilesData.push({
        path: file.path,
        data_enc: fileEnc
      });
    }
  }

  // Get parked branch
  const git = simpleGit(repoRoot);
  let parkedBranch;
  try {
    parkedBranch = git.symbolicRef(['--short', 'HEAD']).trim();
  } catch (err) {
    parkedBranch = null;
  }

  // Load meta and assign letter
  const meta = loadMeta();
  const allProjectFiles = listProjects();
  const activeIds = allProjectFiles.map(p => p.id);
  const allUsedIds = [...meta.retiredIds, ...activeIds];
  const id = existingProject ? existingProject.id : getNextLetter(allUsedIds);

  // Build project JSON
  const projectData = {
    id: id,
    name: projectName,
    remote: remoteUrl,
    remote_push_url: remotePushUrl || null,
    parked_branch: parkedBranch,
    ssh_alias: sshAlias,
    ssh_key_path: sshKeyPath,
    ssh_passphrase_enc: sshPassphraseEnc,
    setup_cmd: setupCmd || null,
    notes: notes || null,
    env_enc: envEnc,
    extra_files: extraFilesData,
    parked_at: new Date().toISOString()
  };

  // Save project
  saveProject(id, projectData);

  // Push to vault
  console.log('Pushing to vault...');
  const pushResult = await pushVault('park: add project ' + projectName);

  if (pushResult === false) {
    console.log('Vault push failed. Your local folder is safe. Check connection and try again.');
    return;
  }

  // STEP 8 — DELETE
  console.log('');
  console.log('This will permanently delete ' + repoRoot + '.');

  const { confirmDelete } = await inquirer.prompt([
    {
      type: 'input',
      name: 'confirmDelete',
      message: 'Type the project name to confirm:'
    }
  ]);

  if (confirmDelete !== projectName) {
    console.log('Cancelled.');
    return;
  }

  fs.rmSync(repoRoot, { recursive: true, force: true });
  console.log('Parked as [' + id + ']. Use parking unpark ' + id + ' to restore.');
}

async function askConfigQuestions() {
  const { setupCmd } = await inquirer.prompt([
    {
      type: 'input',
      name: 'setupCmd',
      message: 'Setup command? (e.g. npm install, pip install -r requirements.txt, yarn)',
      default: ''
    }
  ]);

  const { extraFilesInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'extraFilesInput',
      message: 'Extra files? (comma-separated relative paths, e.g. config/local.json,certs/dev.pem)',
      default: ''
    }
  ]);

  const extraFiles = [];
  if (extraFilesInput && extraFilesInput.trim()) {
    const paths = extraFilesInput.split(',').map(p => p.trim()).filter(p => p);
    for (const p of paths) {
      extraFiles.push({ path: p });
    }
  }

  // SSH alias selection
  const knownKeys = parseSshConfig();
  const sshChoices = [
    { name: 'None', value: 'none' }
  ];

  if (knownKeys.length > 0) {
    for (const k of knownKeys) {
      sshChoices.push({
        name: k.alias + ' (' + k.identityFile + ')',
        value: 'known:' + k.alias + ':' + k.identityFile
      });
    }
  }
  sshChoices.push({ name: 'Custom alias', value: 'custom' });

  const { sshChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'sshChoice',
      message: 'SSH host alias?',
      choices: sshChoices
    }
  ]);

  let sshAlias = null;
  let sshKeyPath = null;

  if (sshChoice.startsWith('known:')) {
    const parts = sshChoice.split(':');
    sshAlias = parts[1];
    sshKeyPath = parts[2];
  } else if (sshChoice === 'custom') {
    const { customAlias } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customAlias',
        message: 'Enter SSH alias:'
      }
    ]);

    const { customKeyPath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'customKeyPath',
        message: 'Enter the private key path for this alias:',
        validate: (input) => {
          if (!input || input.trim() === '') {
            return 'Key path is required';
          }
          if (!fs.existsSync(input)) {
            return 'File does not exist';
          }
          return true;
        }
      }
    ]);

    sshAlias = customAlias;
    sshKeyPath = customKeyPath;
  }

  // SSH passphrase
  let sshPassphrase = null;
  if (sshKeyPath) {
    const { hasPassphrase } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'hasPassphrase',
        message: 'Does this SSH key have a passphrase?',
        default: false
      }
    ]);

    if (hasPassphrase) {
      const { storePassphrase } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'storePassphrase',
          message: 'Store passphrase encrypted in vault? (If not, you will be prompted manually on unpark)',
          default: true
        }
      ]);

      if (storePassphrase) {
        const { passphrase } = await inquirer.prompt([
          {
            type: 'password',
            name: 'passphrase',
            message: 'Enter SSH passphrase:',
            mask: '*'
          }
        ]);
        sshPassphrase = passphrase;
      }
    }
  }

  const { notes } = await inquirer.prompt([
    {
      type: 'input',
      name: 'notes',
      message: 'Notes? (free text, shown after unpark)',
      default: ''
    }
  ]);

  return {
    setupCmd,
    extraFiles,
    sshAlias,
    sshKeyPath,
    sshPassphrase,
    notes
  };
}

module.exports = parkCommand;
