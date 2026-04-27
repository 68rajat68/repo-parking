const {
  ensureVaultExists,
  listProjects,
  listBundles,
} = require("../lib/vault");

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "today";
  } else if (diffDays === 1) {
    return "1 day ago";
  } else if (diffDays < 7) {
    return diffDays + " days ago";
  } else if (diffDays < 14) {
    return "1 week ago";
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks + " weeks ago";
  } else {
    const months = Math.floor(diffDays / 30);
    return months + " month" + (months > 1 ? "s" : "") + " ago";
  }
}

function printRepoTable(projects) {
  console.log(
    "Letter  Name" +
      " ".repeat(30 - 4) +
      "Remote" +
      " ".repeat(40 - 6) +
      "Parked",
  );
  console.log("-".repeat(90));
  for (const project of projects) {
    const letter = project.id.padEnd(7);
    const name = (project.name || "").substring(0, 28).padEnd(30);
    const remote = (project.remote || "").substring(0, 38).padEnd(40);
    const time = formatTimeAgo(project.parked_at);
    console.log(letter + name + remote + time);
  }
}

function printBundleTable(bundles) {
  console.log(
    "Letter  Name" +
      " ".repeat(30 - 4) +
      "Files" +
      " ".repeat(12 - 5) +
      "Parked",
  );
  console.log("-".repeat(90));
  for (const b of bundles) {
    const letter = b.id.padEnd(7);
    const name = (b.name || "").substring(0, 28).padEnd(30);
    const fc = String(b.file_count != null ? b.file_count : "?").padEnd(12);
    const time = formatTimeAgo(b.parked_at);
    console.log(letter + name + fc + time);
  }
}

async function listCommand() {
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

  const repos = listProjects();
  const bundles = listBundles();

  if (repos.length === 0 && bundles.length === 0) {
    console.log("No parked repositories or file bundles.");
    console.log("");
    console.log("Quick start:");
    console.log("  Git repo: cd to your repository, run \x1b[36mparking park <name>\x1b[0m");
    console.log(
      "  Files:    run \x1b[36mparking park -f <name>\x1b[0m and pick paths to encrypt into the vault.",
    );
    return;
  }

  console.log("");

  if (repos.length > 0) {
    console.log("\x1b[1mRepositories\x1b[0m");
    printRepoTable(repos);
    console.log("");
  } else {
    console.log("\x1b[1mRepositories\x1b[0m");
    console.log("  (none)");
    console.log("");
  }

  if (bundles.length > 0) {
    console.log("\x1b[1mFiles & folders\x1b[0m");
    printBundleTable(bundles);
    console.log("");
  } else {
    console.log("\x1b[1mFiles & folders\x1b[0m");
    console.log("  (none)");
    console.log("");
  }
}

module.exports = listCommand;
