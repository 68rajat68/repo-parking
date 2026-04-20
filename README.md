# repo-parking

Park and unpark git repos to save disk space. When you park a repository, it removes the local copy but saves everything to your private vault repository. Unpark to restore it on any machine.

**Compatibility:** macOS and Linux only. Node.js v18+ required.

---

## Installation

```bash
npm install -g repo-parking
```

---

## Before First Use

1. Go to GitHub (or GitLab) and create a new **private** repository to use as your vault.
2. **Do NOT check "Initialize with README"** when creating the vault repo.
3. Copy the SSH remote URL of your vault repository (looks like `git@github.com:user/vault.git`).

---

## Setup

```bash
parking init
```

You'll be asked for:

- Vault repo remote URL
- Master password (never stored - memorize this!)

**WARNING:** Your master password cannot be recovered. Store it in a password manager if you rely on this tool.

---

## Commands

### `parking park <name>`

Park the current repository. Removes local files but preserves everything in your vault.

```bash
cd my-project
parking park my-app
```

You'll be asked about:

- Setup command (e.g., `npm install`)
- Extra files to preserve (beyond .env)
- SSH alias for this repo
- Notes

### `parking list`

Show all parked projects.

```
Letter  Name                           Remote                               Parked
-------------------------------------------------------------------------------
A       my-app                         git@github.com:user/repo.git        2 days ago
B       api-server                     git@github.com:user/api.git         1 week ago
```

### `parking status <name or letter>`

Show details of a parked project.

```bash
parking status my-app
parking status A
```

### `parking unpark <name or letter>`

Restore a parked project to the current directory.

```bash
parking unpark my-app
parking unpark A
```

You'll be asked to confirm before running the setup command.

### `parking forget <name or letter>`

Remove a project from the vault (does NOT delete the remote repo).

```bash
parking forget my-app
parking forget A
```

---

## Security Notes

### Setup Command Security

The setup command stored in your vault runs on unpark. Since your vault is your private repository, only you control what runs. `parking` always shows you the command and asks for confirmation before running it.

### Master Password

Your master password is never saved anywhere. All sensitive data (.env files, SSH passphrases) is encrypted with AES-256-GCM using your master password as the key derivation input. If you forget it, your parked .env files and extra files cannot be recovered.

### SSH Keys

When parking, you can associate an SSH alias. On unpark, `parking` will look up the corresponding key in your `~/.ssh/config`. If the alias can't be resolved on the target machine, it falls back to the stored key path if that file exists.

---

## SSH Troubleshooting

### "Could not auto-load SSH key"

This is a warning, not a fatal error. The clone will still proceed. You may be prompted for your SSH passphrase during the clone.

To fix:

1. Ensure your SSH key is in your agent: `ssh-add ~/.ssh/id_ed25519`
2. Or pre-load before running unpark: `ssh-add /path/to/key`

### Key not found on new machine

If you set up an SSH alias when parking but that alias isn't in your `~/.ssh/config` on the current machine, `parking` falls back to the stored key path. If that path also doesn't exist, you'll need to manually run `ssh-add` before unparking.

---

## Letter Permanence

Project letters (A, B, C...) are permanent identifiers. Once assigned, a letter is never reused. If you "forget" a project, its letter is retired forever and will appear as a gap in the letter sequence. This is intentional — it ensures letter references remain stable.

---

## Unique Names

Project names must be unique across all parked repos. If you try to park two repos with the same name, you'll be asked to rename one.

---

## Technical Details

- Encryption: AES-256-GCM with PBKDF2 key derivation (100,000 iterations, SHA-256)
- All sensitive data encrypted before storage in vault
- Vault is a standard git repository
- Projects stored as individual JSON files in `vault/projects/`
