const { ensureVaultExists, loadProject } = require("../lib/vault");

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const options = { month: "long", day: "numeric", year: "numeric" };
  const dateStr = date.toLocaleDateString("en-US", options);

  if (diffDays === 0) {
    return dateStr + " (today)";
  } else if (diffDays === 1) {
    return dateStr + " (1 day ago)";
  } else {
    return dateStr + " (" + diffDays + " days ago)";
  }
}

async function statusCommand(nameOrLetter) {
  let offline = false;

  try {
    await ensureVaultExists();
  } catch (err) {
    if (err.message.startsWith("VAULT_PULL_FAILED:")) {
      offline = true;
      const { vaultPath } = require("../lib/vault");
      if (!require("fs").existsSync(vaultPath)) {
        console.error("Vault not found. Run parking init first.");
        return;
      }
    } else {
      console.error("Vault error:", err.message);
      return;
    }
  }

  if (offline) {
    console.log(
      "\x1b[33m⚠ Could not reach vault. Showing cached local data.\x1b[0m",
    );
  }

  const project = loadProject(nameOrLetter);

  if (!project) {
    console.error("Project not found:", nameOrLetter);
    console.log("");
    console.log("Run \x1b[36mparking list\x1b[0m to see all parked entries.");
    return;
  }

  const isBundle = project.kind === "bundle";

  console.log("");
  console.log("Type:      " + (isBundle ? "Files & folders" : "Git repository"));
  console.log("Letter:    " + project.id);
  console.log("Name:      " + project.name);
  console.log("Parked at: " + formatDate(project.parked_at));

  if (isBundle) {
    if (project.bundle_root) {
      console.log("Source:    " + project.bundle_root + " (path when parked)");
    }
    console.log(
      "Files:     " +
        (project.file_count != null ? project.file_count : "?") +
        " file(s) in archive",
    );
    if (project.plaintext_bytes != null) {
      console.log(
        "Size:      " +
          Math.round((project.plaintext_bytes / (1024 * 1024)) * 100) / 100 +
          " MiB (approx. before encrypt)",
      );
    }
    if (project.removed_local === true) {
      console.log("Local:     selected paths were removed after parking");
    } else if (project.removed_local === false) {
      console.log("Local:     copy kept on disk after parking");
    }
    if (project.parked_paths && project.parked_paths.length > 0) {
      console.log("Paths:");
      for (const p of project.parked_paths) {
        console.log("  - " + p);
      }
    }
    if (project.notes) {
      console.log("Notes:     " + project.notes);
    }
    console.log("");
    return;
  }

  console.log("Remote:    " + project.remote);
  if (project.remote_push_url) {
    console.log("Push URL:  " + project.remote_push_url);
  }

  if (project.parked_branch) {
    console.log("Branch:    " + project.parked_branch);
  }
  if (project.ssh_alias) {
    console.log("SSH alias: " + project.ssh_alias);
  }
  if (project.ssh_key_path) {
    console.log("SSH key:   " + project.ssh_key_path);
  }
  if (project.setup_cmd) {
    console.log("Setup:     " + project.setup_cmd);
  }
  if (project.notes) {
    console.log("Notes:     " + project.notes);
  }

  console.log("");
  console.log(".env stored: " + (project.env_enc ? "yes" : "no"));

  if (project.extra_files && project.extra_files.length > 0) {
    console.log("Extra files:");
    for (const file of project.extra_files) {
      console.log("  - " + file.path);
    }
  } else {
    console.log("Extra files: none");
  }
  console.log("");
}

module.exports = statusCommand;
