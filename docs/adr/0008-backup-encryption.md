# 0008. Backup format and encryption

Status: Decided. Throughput measured on the 8 GB M1.
Requirements: BKP-01, BKP-02, BKP-03, SEC-04, SEC-06, SEC-08, MIG-02, Q29, Q30, T08

## Context

Backups are optional-password encrypted, recommended by default. BKP-02 requires a maintained authenticated-encryption format and reviewed password derivation, with no custom cryptography. Unattended encrypted schedules may keep a key in OS facilities if disclosed. §16 leaves the archive encryption format open.

## Options

| Criterion | age v1 (typage in TypeScript, or rage) | libsodium secretstream + Argon2id | OpenPGP (openpgp.js) | zip with AES |
|---|---|---|---|---|
| Container format | Specified and stable (age-encryption.org/v1), with independent implementations. | Primitive only. We would define the header, KDF parameters, and framing ourselves, which is custom cryptography by another name. | Specified, but very large surface. | Several incompatible AES schemes. Weak integrity in some. |
| Streaming and truncation | 64 KiB ChaCha20-Poly1305 chunks with a final-chunk flag. Truncation is detected. | Same properties if framed correctly by us. | Yes. | Varies. |
| Password KDF | scrypt with a work factor stored in the header. | Argon2id. | Argon2 or iterated S2K, depending on version. | PBKDF2 or weaker. |
| Public-key recipients | X25519 built in. | Separate box construction we would compose. | Yes. | No. |
| License | BSD-3-Clause (age, typage), Apache-2.0/MIT (rage). | ISC. | LGPL-3.0. | Varies. |
| User recovery without Citspark | `age -d` from the official CLI. | Needs Citspark. | `gpg`. | Common tools. |

## Evidence

From `prototypes/backup-age` (age-encryption 0.3.1, Node 26, Apple M1 8 GB):

- 64 MiB streamed through passphrase encryption in 1.35 s and decryption in 1.21 s (about 50 MB/s each way, single thread). Ciphertext overhead was 16,550 bytes (0.02%).
- Wrong passphrase, one flipped byte, and truncation by 70,000 bytes all failed with an error. A wrong passphrase fails at the header before any plaintext. A flipped byte or truncation fails only when the stream reaches the damaged chunk or the missing end: 64 KiB and 256 KiB of earlier, authenticated plaintext had already been emitted.
- An X25519 recipient round-trip worked, which is the unattended schedule path.

## Decision

- **Archive**: a tar stream containing `manifest.json` first, then a consistent SQLite snapshot (online backup API or `VACUUM INTO`), then content-addressed blobs. The manifest records schema version, library ID, creation time, per-file SHA-256, media inventory, whether derived indexes are included, and encryption metadata (BKP-03). Credentials are never written (SEC-04).
- **Encrypted backups**: the same tar wrapped in age v1. File extension `.citspark.tar.age`. Plaintext backups are `.citspark.tar`.
- **Password mode**: age's scrypt recipient. When a passphrase is used it must be the only recipient (age requires this). Work factor `logN = 18` by default, tuned so derivation takes about 1 s on the reference machine.
- **Unattended schedules**: generate an X25519 identity, keep it in the OS credential store through Electron `safeStorage`, and encrypt scheduled backups to its recipient. Offer a recovery kit: the identity, itself age-encrypted with a user passphrase, saved where the user chooses. Disclose that anyone with the user's OS session can decrypt scheduled backups (BKP-02).
- **Restore**: decrypt as a stream into a staging directory. While extracting, reject absolute paths, `..`, symlinks, and device entries (SEC-06) and enforce size quotas. A damaged or truncated archive emits a valid prefix before it fails, so nothing in staging is used until the decrypt stream has ended without error. Then verify every hash against the manifest and open the snapshot in a fresh library. Only switch after verification (MIG-02).
- **Retention**: see `docs/f0/resolved-engineering-details.md`.

## Consequences

- Password derivation uses scrypt instead of Argon2id. Both are memory-hard and reviewed. age's choice is fixed by its specification, and using age avoids defining our own container. This differs from an Argon2id design and is listed for owner review.
- Throughput of about 50 MB/s single-threaded means a 20 GiB media library takes about 7 minutes to encrypt. Acceptable for scheduled background work. Measure on Windows and Linux.
- Users can always decrypt with the official `age` CLI, then read the tar and SQLite file with standard tools.
- SEC-08: backup encryption does not encrypt the live library. The docs must say so.

## Still to validate

- Full T08: restore into a fresh installation with annotations, policy scopes, relationships, and cited snapshots; missing media; unavailable destination (M2-08).
- Throughput on large media sets and on the slowest supported CPU (M5-02).
