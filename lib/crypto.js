const crypto = require('crypto');

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
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, encrypted, authTag]).toString('base64');
}

function decrypt(encryptedData, password) {
  const buf = Buffer.from(encryptedData, 'base64');
  const salt = buf.slice(0, 32);
  const iv = buf.slice(32, 48);
  const authTag = buf.slice(buf.length - 16);
  const cipher = buf.slice(48, buf.length - 16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error('Incorrect master password');
  }
}

module.exports = {
  encrypt,
  decrypt
};
