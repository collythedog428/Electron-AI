import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hub, HttpError } from "../lib/hub.js";
import { KeyStore } from "../lib/key-store.js";

const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };

test("the name is saved to the profile file and comes back on a new launch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "profile-test-"));
  try {
    const profileFile = path.join(dir, "profile.json");
    const store = new KeyStore({ file: path.join(dir, "k.bin"), crypto });
    const first = new Hub({ keyStore: store, profileFile });
    await first.setName("  Archie   Smith ");
    assert.equal(first.status().name, "Archie Smith");
    assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), { name: "Archie Smith" });

    const second = new Hub({ keyStore: store, profileFile });
    await second.init();
    assert.equal(second.status().name, "Archie Smith");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("names that are empty or too long are refused", async () => {
  const hub = new Hub({ keyStore: new KeyStore({ file: "unused", crypto }) });
  await assert.rejects(hub.setName("   "), HttpError);
  await assert.rejects(hub.setName("x".repeat(41)), HttpError);
  assert.equal(hub.status().name, "");
});
