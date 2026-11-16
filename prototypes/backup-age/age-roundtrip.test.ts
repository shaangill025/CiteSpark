import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

const MIB = 1024 * 1024;
const PASSPHRASE = 'correct horse battery staple synthetic';

function source(bytes: number, chunk = MIB): { stream: ReadableStream<Uint8Array>; digest: () => string } {
  const h = createHash('sha256');
  let sent = 0;
  return {
    stream: new ReadableStream({
      pull(c) {
        if (sent >= bytes) return c.close();
        const b = randomBytes(Math.min(chunk, bytes - sent));
        h.update(b);
        sent += b.length;
        c.enqueue(new Uint8Array(b));
      },
    }),
    digest: () => h.digest('hex'),
  };
}

async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of s) parts.push(p);
  return new Uint8Array(Buffer.concat(parts));
}

async function sha256Stream(s: ReadableStream<Uint8Array>): Promise<string> {
  const h = createHash('sha256');
  for await (const p of s) h.update(p);
  return h.digest('hex');
}

const once = (b: Uint8Array) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(b), c.close()) });

async function encryptWithPassphrase(bytes: number) {
  const src = source(bytes);
  const e = new Encrypter();
  e.setPassphrase(PASSPHRASE);
  const t = performance.now();
  const ciphertext = await collect(await e.encrypt(src.stream));
  return { ciphertext, plainDigest: src.digest(), encryptMs: performance.now() - t };
}

test('T08 passphrase backup round-trips a 64 MiB stream byte-for-byte', async () => {
  const { ciphertext, plainDigest, encryptMs } = await encryptWithPassphrase(64 * MIB);
  const d = new Decrypter();
  d.addPassphrase(PASSPHRASE);
  const t = performance.now();
  const digest = await sha256Stream(await d.decrypt(once(ciphertext)));
  const decryptMs = performance.now() - t;
  assert.equal(digest, plainDigest);
  console.log(JSON.stringify({ bytes: 64 * MIB, ciphertextBytes: ciphertext.length, encryptMs: Math.round(encryptMs), decryptMs: Math.round(decryptMs) }));
});

test('T08 wrong passphrase is rejected before any plaintext is produced', async () => {
  const { ciphertext } = await encryptWithPassphrase(MIB);
  const d = new Decrypter();
  d.addPassphrase('wrong passphrase');
  await assert.rejects(async () => sha256Stream(await d.decrypt(once(ciphertext))));
});

test('T08 a corrupted byte in the payload fails authentication', async () => {
  const { ciphertext } = await encryptWithPassphrase(4 * MIB);
  const bad = ciphertext.slice();
  bad[Math.floor(bad.length / 2)] ^= 0x01;
  const d = new Decrypter();
  d.addPassphrase(PASSPHRASE);
  await assert.rejects(async () => sha256Stream(await d.decrypt(once(bad))));
});

test('T08 a truncated archive fails instead of restoring a prefix', async () => {
  const { ciphertext } = await encryptWithPassphrase(4 * MIB);
  const d = new Decrypter();
  d.addPassphrase(PASSPHRASE);
  await assert.rejects(async () => sha256Stream(await d.decrypt(once(ciphertext.slice(0, ciphertext.length - 70_000)))));
});

test('BKP-02 unattended schedules can encrypt to an X25519 recipient held by the OS keychain', async () => {
  const identity = await generateX25519Identity();
  const e = new Encrypter();
  e.addRecipient(await identityToRecipient(identity));
  const src = source(2 * MIB);
  const ciphertext = await collect(await e.encrypt(src.stream));
  const d = new Decrypter();
  d.addIdentity(identity);
  assert.equal(await sha256Stream(await d.decrypt(once(ciphertext))), src.digest());
});
