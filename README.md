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

**IMPORTANT:** During init, a **recovery key** will be shown. This is your safety net if you forget your password. Write it down and store it safely — it will NOT be shown again.

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

**Safety:** Parking checks ALL local branches for unpushed commits. If any branch has unpushed work, parking is blocked to prevent data loss.

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

### `parking change-password`

Change your master password without re-encrypting vault data. The encryption key (MEK) stays the same — only the password wrapper changes.

```bash
parking change-password
```

You'll be asked for:

- Current master password
- New master password
- Whether to generate a new recovery key

### `parking recover`

Reset your master password using the recovery key. This restores access to your vault without losing any parked projects.

```bash
parking recover
```

You'll be asked for:

- Recovery key (format: `xxxx-xxxx-xxxx-xxxx-xxxx`)
- New master password
- Whether to generate a new recovery key

---

## Security Notes

### Recovery Key

During `parking init`, a recovery key is generated and shown ONCE. This key:

- Is stored encrypted in your vault
- Can reset your password if forgotten
- Is the ONLY way to recover if you forget your password
- Should be stored safely (password manager, secure note, etc.)

**WARNING:** If you forget both your password AND lose your recovery key, your parked .env files and extra files cannot be recovered.

### Setup Command Security

The setup command stored in your vault runs on unpark. Since your vault is your private repository, only you control what runs. `parking` always shows you the command and asks for confirmation before running it.

### Master Password

Your master password is never saved anywhere. The password wraps a master encryption key (MEK) which encrypts all vault data. This architecture allows:

- Password changes without re-encrypting all data
- Password recovery via recovery key

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
- MEK (Master Encryption Key): 32-byte random key used for all vault data encryption
- Password-based MEK wrapping: PBKDF2-derived key wraps the MEK
- Recovery key wrapping: Recovery key raw bytes wrap the MEK as backup
- HMAC-SHA256 verifier confirms correct password without decrypting data
- All sensitive data encrypted before storage in vault
- Vault is a standard git repository
- Projects stored as individual JSON files in `vault/projects/`
- Meta information stored in `vault/meta.json`
