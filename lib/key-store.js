// Stores the API key encrypted with the OS keychain via Electron's safeStorage.
// On Windows this is DPAPI, so the blob can only be decrypted by the same
// Windows user account on the same machine. The plaintext key is never written
// to disk, logged, or sent to the renderer.
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export class KeyStore {
  /**
   * @param {object} opts
   * @param {string} opts.file   Path of the encrypted blob.
   * @param {object} opts.crypto Object with isEncryptionAvailable/encryptString/decryptString (Electron safeStorage).
   */
  constructor({ file, crypto }) {
    this.file = file;
    this.crypto = crypto;
  }

  available() {
    return Boolean(this.crypto?.isEncryptionAvailable?.());
  }

  async save(secret) {
    if (!this.available()) {
      throw new Error("Secure storage is not available on this system, so the key was not saved.");
    }
    const blob = this.crypto.encryptString(secret);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, blob, { mode: 0o600 });
    await rename(tmp, this.file); // atomic replace on the same volume
  }

  async load() {
    let blob;
    try {
      blob = await readFile(this.file);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    if (!this.available()) {
      throw new Error("Secure storage is not available; cannot unlock the saved key.");
    }
    return this.crypto.decryptString(blob) || null;
  }

  async delete() {
    try {
      await unlink(this.file);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}
