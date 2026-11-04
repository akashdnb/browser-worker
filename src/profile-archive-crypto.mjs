import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const HEADER_LIMIT = 4096;
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;

function deriveKey(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("Browser profile encryption requires a secret of at least 32 bytes");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("utils-browser-worker-profile-v1", "utf8"),
    Buffer.from("github-actions-artifact-encryption", "utf8"),
    32,
  ));
}

export function profileEncryptionSecrets(env = process.env) {
  return [
    env.BROWSER_WORKER_PROFILE_ENCRYPTION_KEY,
    env.UTILS_BROWSER_WORKER_TOKEN,
  ].filter((value, index, values) =>
    typeof value === "string" && value.length >= 32 && values.indexOf(value) === index
  );
}

export async function encryptFile(inputPath, outputPath, secret) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const header = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
  };

  await writeFile(outputPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
  try {
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: "a", mode: 0o600 }),
    );
    await appendFile(outputPath, cipher.getAuthTag(), { mode: 0o600 });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

async function decryptWithSecret(inputPath, outputPath, secret) {
  const handle = await open(inputPath, "r");
  try {
    const headerBuffer = Buffer.alloc(HEADER_LIMIT);
    const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
    const newline = headerBuffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error("Encrypted profile artifact header is missing or too large");

    const header = JSON.parse(headerBuffer.subarray(0, newline).toString("utf8"));
    if (header.version !== 1 || header.algorithm !== "aes-256-gcm") {
      throw new Error("Unsupported encrypted profile artifact format");
    }
    const iv = Buffer.from(header.iv ?? "", "base64");
    if (iv.length !== IV_BYTES) throw new Error("Encrypted profile artifact has an invalid IV");

    const file = await handle.stat();
    const dataStart = newline + 1;
    if (file.size < dataStart + AUTH_TAG_BYTES) {
      throw new Error("Encrypted profile artifact is truncated");
    }

    const authTag = Buffer.alloc(AUTH_TAG_BYTES);
    await handle.read(authTag, 0, authTag.length, file.size - AUTH_TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(authTag);
    await pipeline(
      createReadStream(inputPath, { start: dataStart, end: file.size - AUTH_TAG_BYTES - 1 }),
      decipher,
      createWriteStream(outputPath, { mode: 0o600 }),
    );
  } finally {
    await handle.close();
  }
}

export async function decryptFile(inputPath, outputPath, secrets) {
  const candidates = Array.isArray(secrets) ? secrets : [secrets];
  if (!candidates.length) throw new Error("Browser profile decryption key is not configured");

  let lastError;
  for (const secret of candidates) {
    try {
      await decryptWithSecret(inputPath, outputPath, secret);
      return;
    } catch (error) {
      lastError = error;
      await rm(outputPath, { force: true });
    }
  }
  throw new Error("Could not decrypt browser profile artifact with the configured key(s)", { cause: lastError });
}

const [operation, inputPath, outputPath] = process.argv.slice(2);
if (operation) {
  if (!["encrypt", "decrypt"].includes(operation) || !inputPath || !outputPath) {
    throw new Error("Usage: node src/profile-archive-crypto.mjs <encrypt|decrypt> <input> <output>");
  }
  const secrets = profileEncryptionSecrets();
  if (operation === "encrypt") {
    if (!secrets.length) throw new Error("Set BROWSER_WORKER_PROFILE_ENCRYPTION_KEY or UTILS_BROWSER_WORKER_TOKEN");
    await encryptFile(inputPath, outputPath, secrets[0]);
  } else {
    await decryptFile(inputPath, outputPath, secrets);
  }
}
