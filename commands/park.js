const inquirer = require("inquirer");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const {
  ensureVaultExists,
  listAllParked,
  loadMeta,
  saveMeta,
  saveProject,
  pushVault,
} = require("../lib/vault");
const {
  isGitRepo,
  hasCommits,
  getRepoRoot,
  getUpstreamInfo,
  getUncommittedFiles,
  getUnpushedCommits,
  commitAndPush,
  pushOnly,
  getAllBranchesWithUnpushed,
} = require("../lib/git");
const { parseSshConfig } = require("../lib/ssh");
const { readEnvFile } = require("../lib/env");
const {
  validateRelativePath,
  encodeFile,
  validateFileSizes,
  getNextLetter,
  getGitignoreFiles,
  getEnvFiles,
  isEnvFilePath,
  sortExtraFilePaths,
} = require("../lib/files");
const { unwrapMEK, encryptWithMEK } = require("../lib/crypto");

function validateProjectName(name) {
  if (!name || name.trim() === "") {
    return { valid: false, error: "Project name cannot be empty." };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Project name can only contain letters, numbers, hyphens, and underscores.",
    };
  }
  if (/^[A-Z]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Names cannot be all uppercase letters (reserved for IDs). Try: my-API, api-server, etc.",
    };
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return {
      valid: false,
      error: "Project name cannot contain path separators or dot-segments.",
    };
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
  if (!(await isGitRepo())) {
    console.error("Not inside a git repository.");
    return;
  }
  if (!(await hasCommits())) {
    console.error("No commits yet. Make at least one commit.");
    return;
  }

  const repoRoot = await getRepoRoot();

  // STEP 2 — RESOLVE CLONEABLE REMOTE
  let upstreamInfo;
  try {
    upstreamInfo = await getUpstreamInfo(repoRoot);
  } catch (err) {
    console.error(err.message);
    return;
  }

  let remoteName, trackingBranch, remoteUrl, remotePushUrl, hasUpstream;

  if (upstreamInfo.availableRemotes) {
    // Multi-remote with no upstream - need to ask user to pick
    const choices = upstreamInfo.availableRemotes.map((r, i) => ({
      name: r,
      value: r,
    }));

    const { selectedRemote } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedRemote",
        message:
          "Multiple remotes found. Which remote should be used for parking?",
        choices: choices,
      },
    ]);

    remoteName = selectedRemote;
    trackingBranch = upstreamInfo.trackingBranch;
    hasUpstream = false;

    const git = simpleGit(repoRoot);
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
      console.error(
        "Remote URL contains embedded credentials. Use SSH or a token URL without username.",
      );
      return;
    }
    if (remotePushUrl && /^https?:\/\/[^@]+@/i.test(remotePushUrl)) {
      console.error(
        "Push URL contains embedded credentials. Remove credentials and use a token without username. SSH URLs do not have this issue.",
      );
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
    if (err.message.startsWith("VAULT_PULL_FAILED:")) {
      console.error(
        "Could not reach vault. Check your internet connection and try again.",
      );
    } else {
      console.error("Vault error:", err.message);
    }
    return;
  }

  const allProjects = listAllParked();
  const reposOnly = allProjects.filter((p) => (p.kind || "repo") !== "bundle");
  if (allProjects.some((p) => p.kind === "bundle" && p.name === name)) {
    console.error(
      'Name "' +
        name +
        '" is already used by a parked files/folder entry. Choose another name.',
    );
    return;
  }
  const nameMatches = reposOnly.filter((p) => p.name === name);
  const remoteMatches = reposOnly.filter((p) => p.remote === remoteUrl);
  const duplicates = reposOnly.filter(
    (p) => p.name === name && p.remote === remoteUrl,
  );

  let existingProject = null;
  let duplicateChoice = "new";

  if (duplicates.length > 0) {
    existingProject = duplicates[0];
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "A project with the same name and remote already exists:",
        choices: [
          { name: "Overwrite existing entry", value: "overwrite" },
          { name: "Create new entry with different name", value: "new" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      console.log("Cancelled.");
      return;
    }
    duplicateChoice = action;
  } else if (nameMatches.length > 0) {
    existingProject = nameMatches[0];
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "A project with the same name but different remote exists:",
        choices: [
          { name: "Create new entry with different name", value: "new" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      console.log("Cancelled.");
      return;
    }
    duplicateChoice = "new";
  } else if (remoteMatches.length > 0) {
    existingProject = remoteMatches[0];
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message:
          'This remote is already parked as "' + existingProject.name + '":',
        choices: [
          { name: "Overwrite existing entry", value: "overwrite" },
          { name: "Create new entry with different name", value: "new" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      console.log("Cancelled.");
      return;
    }
    duplicateChoice = action;
  }

  let projectName = name;
  if (duplicateChoice === "new" && existingProject) {
    // Force user to provide a different name
    const { newName } = await inquirer.prompt([
      {
        type: "input",
        name: "newName",
        message: "Enter a different name for this project:",
        validate: (input) => {
          if (!input || input.trim() === "") {
            return "Project name cannot be empty.";
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
            return "Project name can only contain letters, numbers, hyphens, and underscores.";
          }
          if (/^[A-Z]+$/.test(input)) {
            return "Names cannot be all uppercase letters (reserved for IDs). Try: my-API, api-server, etc.";
          }
          const allProjectsNow = listAllParked();
          if (allProjectsNow.some((p) => p.name === input)) {
            return "A project with this name already exists.";
          }
          return true;
        },
      },
    ]);
    projectName = newName;
  }

  // STEP 4 — PROMPT MASTER PASSWORD
  const { masterPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "masterPassword",
      message: "Master password:",
      mask: "*",
    },
  ]);

  // Unwrap MEK using master password
  const meta = loadMeta();
  let mek;
  try {
    mek = unwrapMEK(meta.mek_wrapped_password, masterPassword);
  } catch (err) {
    console.error("Incorrect master password.");
    return;
  }

  // Print warning only on first park
  if (allProjects.length === 0) {
    console.log(
      "\x1b[33m⚠ Your master password cannot be recovered. Make sure you remember it.\x1b[0m",
    );
  }

  // STEP 5 — GIT SAFETY CHECK
  const uncommittedFiles = await getUncommittedFiles(repoRoot);
  const unpushedCommits = await getUnpushedCommits(
    remoteName,
    trackingBranch,
    hasUpstream,
    repoRoot,
  );

  if (uncommittedFiles.length > 0 && unpushedCommits.length > 0) {
    console.log(
      uncommittedFiles.length +
        " uncommitted file(s), " +
        unpushedCommits.length +
        " unpushed commit(s)",
    );

    const { gitAction } = await inquirer.prompt([
      {
        type: "list",
        name: "gitAction",
        message: "Handle manually or let parking do it?",
        choices: [
          { name: "Handle manually", value: "manual" },
          { name: "Let parking handle it", value: "auto" },
        ],
      },
    ]);

    if (gitAction === "manual") {
      console.log("Cancelled. Please commit and push your changes first.");
      return;
    }

    const { commitMessage } = await inquirer.prompt([
      {
        type: "input",
        name: "commitMessage",
        message: "Commit message:",
      },
    ]);

    const commitResult = await commitAndPush(
      commitMessage,
      remoteName,
      trackingBranch,
      hasUpstream,
      repoRoot,
    );
    if (!commitResult) {
      console.error("Push failed. Aborting.");
      return;
    }
  } else if (unpushedCommits.length > 0) {
    // Clean working tree with unpushed commits
    const pushResult = await pushOnly(
      remoteName,
      trackingBranch,
      hasUpstream,
      repoRoot,
    );
    if (!pushResult) {
      console.error("Push failed. Aborting.");
      return;
    }
  } else if (uncommittedFiles.length > 0) {
    console.log(uncommittedFiles.length + " uncommitted file(s)");

    const { gitAction } = await inquirer.prompt([
      {
        type: "list",
        name: "gitAction",
        message: "Handle manually or let parking do it?",
        choices: [
          { name: "Handle manually", value: "manual" },
          { name: "Let parking handle it", value: "auto" },
        ],
      },
    ]);

    if (gitAction === "manual") {
      console.log("Cancelled. Please commit and push your changes first.");
      return;
    }

    const { commitMessage } = await inquirer.prompt([
      {
        type: "input",
        name: "commitMessage",
        message: "Commit message:",
      },
    ]);

    const commitResult = await commitAndPush(
      commitMessage,
      remoteName,
      trackingBranch,
      hasUpstream,
      repoRoot,
    );
    if (!commitResult) {
      console.error("Push failed. Aborting.");
      return;
    }
  }

  // Check ALL local branches for unpushed commits
  const blockedBranches = await getAllBranchesWithUnpushed(repoRoot);

  if (blockedBranches.length > 0) {
    console.error(
      "\n\x1b[31mERROR: The following branches have unpushed commits:\x1b[0m",
    );
    for (const b of blockedBranches) {
      console.error(
        `  \x1b[33m${b.branchName}\x1b[0m (${b.unpushedCount} unpushed commit${b.unpushedCount === 1 ? "" : "s"})`,
      );
    }
    console.error(
      "\n\x1b[31mParking deletes ALL local branches including the above.\x1b[0m",
    );
    console.error("Push or merge all branches before parking.\n");
    process.exit(1);
  }

  // STEP 6 — PROJECT CONFIGURATION
  let setupCmd = "";
  let extraFiles = [];
  let sshAlias = null;
  let sshKeyPath = null;
  let sshPassphrase = null;
  let sshPassphraseEnc = null;
  let notes = "";

  if (duplicateChoice === "overwrite" && existingProject) {
    // Show existing values, ask K/U
    console.log("");
    console.log("Existing configuration:");
    console.log("  Setup command: " + (existingProject.setup_cmd || "(none)"));
    console.log("  SSH alias: " + (existingProject.ssh_alias || "(none)"));
    console.log("  SSH key: " + (existingProject.ssh_key_path || "(none)"));
    console.log("  Notes: " + (existingProject.notes || "(none)"));

    const { keepUpdate } = await inquirer.prompt([
      {
        type: "list",
        name: "keepUpdate",
        message: "Keep existing or update?",
        choices: [
          { name: "Keep existing", value: "keep" },
          { name: "Update", value: "update" },
        ],
      },
    ]);

    if (keepUpdate === "keep") {
      setupCmd = existingProject.setup_cmd || "";
      extraFiles = existingProject.extra_files || [];
      sshAlias = existingProject.ssh_alias;
      sshKeyPath = existingProject.ssh_key_path;
      sshPassphraseEnc = existingProject.ssh_passphrase_enc;
      notes = existingProject.notes || "";
    } else {
      // Update - ask all questions
      const existingExtraFilePaths = (existingProject.extra_files || []).map(
        (f) => f.path,
      );
      const configAnswers = await askConfigQuestions(
        repoRoot,
        existingExtraFilePaths,
      );
      setupCmd = configAnswers.setupCmd;
      extraFiles = configAnswers.extraFiles;
      sshAlias = configAnswers.sshAlias;
      sshKeyPath = configAnswers.sshKeyPath;
      sshPassphrase = configAnswers.sshPassphrase;
      notes = configAnswers.notes;
      if (sshPassphrase) {
        sshPassphraseEnc = encryptWithMEK(sshPassphrase, mek);
      }
    }
  } else {
    // New project - ask all questions
    const configAnswers = await askConfigQuestions(repoRoot, []);
    setupCmd = configAnswers.setupCmd;
    extraFiles = configAnswers.extraFiles;
    sshAlias = configAnswers.sshAlias;
    sshKeyPath = configAnswers.sshKeyPath;
    sshPassphrase = configAnswers.sshPassphrase;
    notes = configAnswers.notes;
    if (sshPassphrase) {
      sshPassphraseEnc = encryptWithMEK(sshPassphrase, mek);
    }
  }

  // STEP 7 — SNAPSHOT + LETTER ASSIGNMENT
  const envRaw = readEnvFile(repoRoot);
  const envEnc = envRaw ? encryptWithMEK(envRaw.toString("base64"), mek) : null;

  // Read extra files
  const extraFilesData = [];
  for (const file of extraFiles) {
    const fullPath = path.join(repoRoot, file.path);
    if (fs.existsSync(fullPath)) {
      const fileBuffer = fs.readFileSync(fullPath);
      const fileB64 = fileBuffer.toString("base64");
      const fileEnc = encryptWithMEK(fileB64, mek);
      extraFilesData.push({
        path: file.path,
        data_enc: fileEnc,
      });
    }
  }

  // Get parked branch
  const git = simpleGit(repoRoot);
  let parkedBranch;
  try {
    parkedBranch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
  } catch (err) {
    parkedBranch = null;
  }

  // Load meta and assign letter (meta already loaded in Step 4)
  const allProjectFiles = listAllParked();
  const activeIds = allProjectFiles.map((p) => p.id);
  const allUsedIds = [...meta.retiredIds, ...activeIds];
  // Only reuse existing ID if overwriting (duplicateChoice === 'overwrite')
  // For [N] new entry or first park, always get a new letter
  const id =
    duplicateChoice === "overwrite" && existingProject
      ? existingProject.id
      : getNextLetter(allUsedIds);

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
    parked_at: new Date().toISOString(),
  };

  // STEP 8 — DELETE CONFIRMATION FIRST (before vault push)
  console.log("");
  console.log("This will permanently delete " + repoRoot + ".");

  const { confirmDelete } = await inquirer.prompt([
    {
      type: "input",
      name: "confirmDelete",
      message: 'Type "' + projectName + '" to confirm deletion:',
    },
  ]);

  if (confirmDelete !== projectName) {
    console.log("Cancelled. Nothing was pushed to vault.");
    // Rollback: remove the saved project file if it exists (in case of overwrite)
    if (existingProject) {
      // Restore the original project data
      saveProject(existingProject.id, existingProject);
    } else {
      // Just delete the newly created project file
      const projectsDir = require("../lib/vault").vaultPath + "/projects";
      const projectFile = path.join(projectsDir, id + ".json");
      if (fs.existsSync(projectFile)) {
        fs.unlinkSync(projectFile);
      }
    }
    return;
  }

  // Only push to vault AFTER successful confirmation
  saveProject(id, projectData);
  const pushResult = await pushVault("park: add project " + projectName);

  if (pushResult === false) {
    console.log(
      "Vault push failed. Your local folder is safe. Check connection and try again.",
    );
    return;
  }

  // Now safe to delete local folder
  fs.rmSync(repoRoot, { recursive: true, force: true });

  // Move the Node process out of the deleted directory
  const parentDir = path.dirname(repoRoot);
  try {
    process.chdir(parentDir);
  } catch (e) {
    // Ignore if chdir fails
  }

  // Print success message and cd instruction
  console.log(
    "\n\x1b[32m✓ Parked as [" +
      id +
      "]. Use `parking unpark " +
      id +
      "` to restore.\x1b[0m",
  );
  console.log(
    "\n\x1b[90m─────────────────────────────────────────────────\x1b[0m",
  );
  console.log(
    "\x1b[33mYour terminal is still pointing at the deleted folder.\x1b[0m",
  );
  console.log("\x1b[33mRun this to go to the parent directory:\x1b[0m");
  console.log("\n  \x1b[1;36mcd " + parentDir + "\x1b[0m\n");
  console.log(
    "\x1b[90m─────────────────────────────────────────────────\x1b[0m\n",
  );
}

async function askConfigQuestions(repoRoot, existingExtraFiles) {
  let setupCmd = "";
  let firstAttempt = true;
  while (true) {
    const { setupCmdInput } = await inquirer.prompt([
      {
        type: "input",
        name: "setupCmdInput",
        message: firstAttempt
          ? "Setup command? (e.g. npm install && npm run dev, or pip install -r requirements.txt)"
          : "Setup command? (Use && or ; to separate commands, not comma):",
        default: "",
      },
    ]);
    setupCmd = setupCmdInput;

    if (setupCmd && setupCmd.includes(",")) {
      console.log(
        '\x1b[33m⚠ Note: Use "&&" or ";" to separate commands, not comma.\x1b[0m',
      );
      firstAttempt = false;
      continue;
    }
    break;
  }

  // Extra files — gitignore-based checkbox picker
  const extraFiles = await askExtraFiles(repoRoot, existingExtraFiles);

  // SSH alias selection
  const knownKeys = parseSshConfig();
  const sshChoices = [{ name: "None", value: "none" }];

  if (knownKeys.length > 0) {
    for (const k of knownKeys) {
      sshChoices.push({
        name: k.alias + " (" + k.identityFile + ")",
        value: "known:" + k.alias + ":" + k.identityFile,
      });
    }
  }
  sshChoices.push({ name: "Custom alias", value: "custom" });

  const { sshChoice } = await inquirer.prompt([
    {
      type: "list",
      name: "sshChoice",
      message: "SSH host alias?",
      choices: sshChoices,
    },
  ]);

  let sshAlias = null;
  let sshKeyPath = null;

  if (sshChoice.startsWith("known:")) {
    const parts = sshChoice.split(":");
    sshAlias = parts[1];
    sshKeyPath = parts[2];
  } else if (sshChoice === "custom") {
    const { customAlias } = await inquirer.prompt([
      {
        type: "input",
        name: "customAlias",
        message: "Enter SSH alias:",
      },
    ]);

    const { customKeyPath } = await inquirer.prompt([
      {
        type: "input",
        name: "customKeyPath",
        message: "Enter the private key path for this alias:",
        validate: (input) => {
          if (!input || input.trim() === "") {
            return "Key path is required";
          }
          if (!fs.existsSync(input)) {
            return "File does not exist";
          }
          return true;
        },
      },
    ]);

    sshAlias = customAlias;
    sshKeyPath = customKeyPath;
  }

  // SSH passphrase
  let sshPassphrase = null;
  if (sshKeyPath) {
    const { hasPassphrase } = await inquirer.prompt([
      {
        type: "confirm",
        name: "hasPassphrase",
        message: "Does this SSH key have a passphrase?",
        default: false,
      },
    ]);

    if (hasPassphrase) {
      const { storePassphrase } = await inquirer.prompt([
        {
          type: "confirm",
          name: "storePassphrase",
          message:
            "Store passphrase encrypted in vault? (If not, you will be prompted manually on unpark)",
          default: true,
        },
      ]);

      if (storePassphrase) {
        const { passphrase } = await inquirer.prompt([
          {
            type: "password",
            name: "passphrase",
            message: "SSH key passphrase:",
          },
        ]);
        sshPassphrase = passphrase;
      }
    }
  }

  const { notes } = await inquirer.prompt([
    {
      type: "input",
      name: "notes",
      message: "Notes? (free text, shown after unpark)",
      default: "",
    },
  ]);

  return {
    setupCmd,
    extraFiles,
    sshAlias,
    sshKeyPath,
    sshPassphrase,
    notes,
  };
}

async function askExtraFiles(repoRoot, existingExtraFiles) {
  // Step 1: Scan gitignore and recursive env files
  process.stdout.write(
    "\nScanning .gitignore and env files for extra files to preserve...\n",
  );
  const { files: gitignoreFiles, warnings } = await getGitignoreFiles(repoRoot);
  const envFiles = await getEnvFiles(repoRoot);
  const files = sortExtraFilePaths(
    [...new Set([...gitignoreFiles, ...envFiles])].filter((f) => f !== ".env"),
  );

  // Step 2: If warnings exist, show them
  for (const w of warnings) {
    console.log(
      "\x1b[33m⚠ File is large (>500KB), parking will warn: " + w + "\x1b[0m",
    );
  }

  // Step 3: Build checkbox choices
  const choices = files.map((f) => {
    const isEnv = isEnvFilePath(f);
    const wasChecked = existingExtraFiles.includes(f);
    return {
      name: f,
      value: f,
      checked: isEnv || wasChecked,
    };
  });

  // Step 4: Handle cases
  if (choices.length === 0) {
    // No gitignored files found on disk
    console.log(
      "\x1b[90mNo .gitignore'd or env-related files found on disk.\x1b[0m",
    );
    console.log(
      "Enter paths manually (comma-separated) or press Enter to skip:",
    );
    const { manual } = await inquirer.prompt([
      {
        type: "input",
        name: "manual",
        message: "Extra files (optional):",
        default: "",
      },
    ]);
    if (!manual.trim()) return [];
    const manualPaths = manual
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Validate each path
    const validPaths = [];
    for (const p of manualPaths) {
      try {
        validateRelativePath(p, repoRoot);
        validPaths.push({ path: p });
      } catch (e) {
        console.log(
          "\x1b[33m⚠ Skipping invalid path: " +
            p +
            " (" +
            e.message +
            ")\x1b[0m",
        );
      }
    }
    return validPaths;
  }

  // Step 5: Show checkbox list
  console.log(
    "\nSelect extra files to preserve (space to toggle, enter to confirm):",
  );
  console.log(
    "\x1b[90m.env-related files are pre-selected. Others are unchecked by default.\x1b[0m\n",
  );

  const { selected } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selected",
      message: "Extra files to preserve:",
      choices: choices,
      pageSize: 15,
    },
  ]);

  // Step 6: Also offer manual addition
  const { addMore } = await inquirer.prompt([
    {
      type: "confirm",
      name: "addMore",
      message: "Add any files not shown above?",
      default: false,
    },
  ]);

  let manualAdditions = [];
  if (addMore) {
    const { manual } = await inquirer.prompt([
      {
        type: "input",
        name: "manual",
        message: "Enter paths (comma-separated):",
        default: "",
      },
    ]);
    manualAdditions = manual
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Step 7: Combine, deduplicate, validate all paths
  const allPaths = [...new Set([...selected, ...manualAdditions])].filter(
    (p) => p !== ".env",
  );

  const validPaths = [];
  for (const p of allPaths) {
    try {
      validateRelativePath(p, repoRoot);
      validPaths.push({ path: p });
    } catch (e) {
      console.log(
        "\x1b[33m⚠ Skipping invalid path: " + p + " (" + e.message + ")\x1b[0m",
      );
    }
  }

  return validPaths;
}

module.exports = parkCommand;
