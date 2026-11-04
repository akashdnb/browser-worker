import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decryptFile, encryptFile } from "../src/profile-archive-crypto.mjs";

test("profile artifacts are encrypted and can be restored with the worker secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-archive-crypto-"));
  try {
    const source = path.join(root, "profile.tar.gz");
    const encrypted = path.join(root, "profile.tar.gz.enc");
    const restored = path.join(root, "restored.tar.gz");
    const secret = "worker-token-for-test-only-".padEnd(48, "x");
    const payload = Buffer.from("private browser cookies and local storage");

    await writeFile(source, payload);
    await encryptFile(source, encrypted, secret);

    const ciphertext = await readFile(encrypted);
    assert.equal(ciphertext.includes(payload), false);
    await decryptFile(encrypted, restored, ["incorrect-key-that-is-long-enough-000", secret]);
    assert.deepEqual(await readFile(restored), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile artifact encryption rejects tampering and wrong keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-archive-crypto-"));
  try {
    const source = path.join(root, "profile.tar.gz");
    const encrypted = path.join(root, "profile.tar.gz.enc");
    const restored = path.join(root, "restored.tar.gz");
    const secret = "worker-token-for-test-only-".padEnd(48, "x");
    await writeFile(source, "sensitive-state");
    await encryptFile(source, encrypted, secret);

    await assert.rejects(
      decryptFile(encrypted, restored, ["wrong-worker-token-that-is-long-enough"]),
      /Could not decrypt browser profile artifact/,
    );

    const bytes = await readFile(encrypted);
    bytes[bytes.length - 20] ^= 0xff;
    await writeFile(encrypted, bytes);
    await assert.rejects(
      decryptFile(encrypted, restored, [secret]),
      /Could not decrypt browser profile artifact/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
