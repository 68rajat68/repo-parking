const crypto = require("crypto");

/*
 * AES-256-GCM byte layout:
 * [0..31]     = salt (32 bytes, random per encrypt call)
 * [32..47]    = IV (16 bytes, random per encrypt call)
 * [48..N-17]  = ciphertext (variable)
 * [N-16..N-1] = authTag (16 bytes)
 * Minimum total: 64 bytes
 */

function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, encrypted, authTag]).toString("base64");
}

function decrypt(encryptedData, password) {
  const buf = Buffer.from(encryptedData, "base64");
  const salt = buf.slice(0, 32);
  const iv = buf.slice(32, 48);
  const authTag = buf.slice(buf.length - 16);
  const cipher = buf.slice(48, buf.length - 16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString(
      "utf8",
    );
  } catch (err) {
    throw new Error("Incorrect master password");
  }
}

// MEK = Master Encryption Key — 32 random bytes used to encrypt all vault data
function generateMEK() {
  return crypto.randomBytes(32);
}

// Wrap MEK with master password (uses existing encrypt)
function wrapMEK(mek, password) {
  return encrypt(mek.toString("hex"), password);
}

// Unwrap MEK with master password (uses existing decrypt)
function unwrapMEK(wrappedMEK, password) {
  const hex = decrypt(wrappedMEK, password);
  return Buffer.from(hex, "hex");
}

// Generate recovery key — 20 random bytes displayed as 5 groups of 8 hex chars
function generateRecoveryKey() {
  const raw = crypto.randomBytes(20);
  const display = raw
    .toString("hex")
    .match(/.{1,8}/g)
    .join("-");
  return { raw, display };
}

// Wrap MEK with recovery key
function wrapMEKWithRecoveryKey(mek, recoveryKeyRaw) {
  const hexPassword = recoveryKeyRaw.toString("hex");
  return encrypt(mek.toString("hex"), hexPassword);
}

// Unwrap MEK with recovery key
function unwrapMEKWithRecoveryKey(wrappedMEK, recoveryKeyDisplay) {
  const hexPassword = recoveryKeyDisplay.replace(/-/g, "");
  try {
    const decrypted = decrypt(wrappedMEK, hexPassword);
    return Buffer.from(decrypted, "hex");
  } catch (err) {
    throw new Error("Invalid recovery key");
  }
}

// Encrypt using MEK directly (no PBKDF2 — MEK is already a strong key)
function encryptWithMEK(plaintext, mek) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", mek, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

// Decrypt data encrypted with encryptWithMEK
function decryptWithMEK(encryptedData, mek) {
  const buf = Buffer.from(encryptedData, "base64");
  const iv = buf.slice(0, 16);
  const authTag = buf.slice(buf.length - 16);
  const ciphertext = buf.slice(16, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", mek, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    throw new Error("Decryption failed");
  }
}

// Generate verifier — HMAC-SHA256 to confirm correct key without decrypting real data
function generateVerifier(mek) {
  const hmac = crypto.createHmac("sha256", mek);
  hmac.update("repo-parking-verifier-v1");
  return hmac.digest("base64");
}

module.exports = {
  encrypt,
  decrypt,
  generateMEK,
  wrapMEK,
  unwrapMEK,
  generateRecoveryKey,
  wrapMEKWithRecoveryKey,
  unwrapMEKWithRecoveryKey,
  encryptWithMEK,
  decryptWithMEK,
  generateVerifier,
};
