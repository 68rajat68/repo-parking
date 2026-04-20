const inquirer = require("inquirer");
const {
  ensureVaultExists,
  loadProject,
  deleteProject,
  loadMeta,
  saveMeta,
  pushVault,
} = require("../lib/vault");

async function forgetCommand(nameOrLetter) {
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

  const project = loadProject(nameOrLetter);

  if (!project) {
    console.error("Project not found:", nameOrLetter);
    console.log("");
    console.log("Run \x1b[36mparking list\x1b[0m to see all parked projects.");
    return;
  }

  console.log("");
  console.log("Project to forget:");
  console.log("  Letter: " + project.id);
  console.log("  Name:   " + project.name);
  console.log("  Remote: " + project.remote);
  console.log("");
  console.log(
    "This does NOT delete your GitHub repo. Only removes the vault entry.",
  );
  console.log(
    "\x1b[33m⚠ If you have not unparked this project recently, you will lose access to its .env and extra files.\x1b[0m",
  );

  const { confirmName } = await inquirer.prompt([
    {
      type: "input",
      name: "confirmName",
      message: 'Type "' + project.name + '" to confirm:',
      validate: (input) => {
        if (input !== project.name) {
          return "Cancelled.";
        }
        return true;
      },
    },
  ]);

  if (confirmName !== project.name) {
    console.log("Cancelled.");
    return;
  }

  // Save current state for rollback
  const fs = require("fs");
  const path = require("path");
  const { vaultPath } = require("../lib/vault");
  const projectDataPath = path.join(
    vaultPath,
    "projects",
    project.id + ".json",
  );
  let projectData = null;

  try {
    projectData = fs.readFileSync(projectDataPath, "utf8");
  } catch (err) {
    projectData = null;
  }

  const originalMeta = loadMeta();

  // Make local changes
  deleteProject(project.id);
  const newMeta = { retiredIds: [...originalMeta.retiredIds, project.id] };
  saveMeta(newMeta);

  // Attempt push
  const success = await pushVault("forget: remove project " + project.name);

  if (!success) {
    // ROLLBACK — restore both files
    if (projectData) {
      fs.writeFileSync(projectDataPath, projectData);
    }
    saveMeta(originalMeta);
    console.log(
      "Could not reach vault. No changes were made. Try again when online.",
    );
    return;
  }

  console.log(
    "Forgotten. Letter [" +
      project.id +
      "] is retired and will never be reused.",
  );
}

module.exports = forgetCommand;
