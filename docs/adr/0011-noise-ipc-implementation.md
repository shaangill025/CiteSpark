# 0011. Noise IPC implementation: library, handshake patterns, pairing direction

Status: Decided. Supersedes parts of [ADR 0006](0006-local-ipc-pairing.md) (Noise library, KK per connection, pairing step 3, client key storage). The rest of ADR 0006 stands.
Requirements: Q54, Q55, PLG-02, SEC-04, SEC-07, T06, §14 (API contract)

## Context

ADR 0006 chose a Noise channel between the desktop core and each client. It left four things to validate in M1-06:

- which maintained Noise library to use;
- whether that library accepts a WebCrypto key-agreement callback, so that the extension's private key never leaves the browser key store;
- the named pipe DACL on Windows;
- the T06 suite.

The owner's Q8 decision set the order to try: noise-handshake first, then @chainsafe/libp2p-noise, then the wrapped-key approach recorded in a superseding ADR. This is that ADR.

While building the pairing flow, we also found a flaw in ADR 0006 pairing step 3, described below.

## Options

| Criterion | noise-handshake 4.2.1 | @chainsafe/libp2p-noise 17.0.0 | Wrapped key (fallback) |
|---|---|---|---|
| WebCrypto key-agreement callback | No. DH is synchronous (`dh(pub)` returns bytes), and WebCrypto `deriveBits` is async. | No. Its crypto interface is synchronous too. | Not needed. |
| Patterns | XX, IK, NN, NNpsk0, and others. No KK. | XX only. | Same as the chosen library. |
| Runs in an MV3 service worker | Yes. An esbuild browser bundle ran with web globals only, with no `eval`, about 257 KB. | Pulls in libp2p stream types. | Same as the chosen library. |
| License | Apache-2.0 | Apache-2.0 OR MIT | |

## Evidence

The spike ran outside the repository and committed nothing. It found the following:

- Neither library can take an async key-agreement callback, so neither can keep the extension's raw X25519 private key out of memory.
- noise-handshake supports XX and IK. Both run in Node, and they run in a browser bundle that uses only web globals.
- The T06 suite in `packages/core/src/ipc/t06.test.ts` runs against the real server on a real Unix socket or named pipe.

## Decision

**Library.** Use noise-handshake 4.2.1 with sodium-universal. The protocol names are `Noise_XX_25519_ChaChaPoly_BLAKE2b` (pairing) and `Noise_IK_25519_ChaChaPoly_BLAKE2b` (sessions). BLAKE2b replaces the BLAKE2s named in ADR 0006, because the library implements BLAKE2b. We use the library's DH, cipher and hash; we do not hand-roll any primitive.

**Client key storage: the wrapped-key fallback.**

- At rest, the client's X25519 private key is encrypted with AES-GCM. The wrapping key is a non-extractable WebCrypto key.
- The additional data is `citspark/client-static-key/v1 || publicKey`, so a wrapped blob cannot be swapped onto a different public key.
- **Weaker property, recorded as Q8 requires:** the raw private key is in memory while a handshake runs. Code running inside the extension, or a debugger attached to it, can read the key at that point. Script cannot export it from IndexedDB at rest.
- The extension still needs to bundle `sodium-javascript` for the browser build. That is M1-08.

**IK instead of KK for every connection.**

- noise-handshake has no KK. IK gives the same mutual authentication, using keys already pinned at pairing.
- The client sends its static key, encrypted, in message 1. The desktop looks that key up in its registry and closes the connection without replying if the key is unknown, revoked, or paired under a different client kind.
- Fresh ephemeral keys on both sides mean a replayed message 1 cannot produce session keys that the replayer holds. Its replayed records fail to decrypt, and nothing runs (T06).
- The trade-off: under IK, a peer that has stolen a client's private key can impersonate that client to the desktop. That is no worse than KK, which fails the same way.

**Pairing direction: the client shows the code and the user types it into the desktop.**

- **The flaw in ADR 0006 step 3.** The user types the code into the client, and the client then sends `pair.confirm`. A rogue local process can open the socket, derive the code from its own handshake hash, and send `pair.confirm` itself. The desktop would never learn whether a person compared anything.
- **The fix.** The client shows the code. The user types it into the desktop's pairing dialog, and the desktop compares it in constant time. One user action now proves that a person approved this client and detects a man in the middle. A rogue process cannot type into the desktop dialog. `pair.confirm` is removed from the protocol, and the code never travels on the wire.
- **Commit and reveal.** After XX, the desktop sends `pair.commit` = BLAKE2b-256(`citspark/pair/commit/v1`, H, Nd). The client then sends its nonce Nc, and the desktop reveals Nd.
  - The code is BLAKE2b-256(`citspark/pair/code/v1`, H, Nc, Nd), read as its first 8 bytes mod 10^6 and shown as 6 digits.
  - The client checks the commitment before showing the code. This stops a man in the middle from trying many keys until the codes on both sides match.
- **Policy, unchanged in intent from ADR 0006.**
  - Codes are single-use and expire after 2 minutes. Only one pairing can be pending at a time.
  - Five wrong codes across all attempts lock pairing until the user unlocks it on the desktop.
  - `desktop-ui` cannot pair over the socket, and a key that is already paired cannot pair again.
  - If there is no desktop dialog to show the prompt, pairing is refused.

**Wire binding.**

- The plaintext `hello` and its reply are bound into the Noise prologue as canonical JSON (sorted keys). Chrome re-serializes native messaging JSON, so we cannot bind the raw bytes.
- `hello` gains a `channel` field, `pair` or `session`, that selects XX or IK. Because the field is in the prologue, a downgrade fails the handshake.
- After the handshake, only `rec` frames are accepted. Each record carries a flag byte and is chunked at 65,518 bytes of plaintext (one Noise message minus the tag and flag).
- The nonce is capped below 2^32, because the library writes a 32-bit counter. Any decrypt failure ends the channel for good.

**Server checks per frame.**

- The registry is re-checked for every frame, so revocation also closes live connections.
- Each request is checked for scope, method and version.
- Requests that change data are kept in a per-client idempotency ledger. The ledger is keyed on the request ID, and a reused ID with a different payload is rejected.

**Native messaging host.**

- The host checks the caller origin against `allowed_origins` in `native-host.json` and exits with code 2 on a mismatch.
- It relays length-prefixed frames to the socket and keeps no state.
- It never parses past the frame boundary, so it only ever sees the plaintext hello and then ciphertext.
- Limits: 128 KiB per frame toward the core, and 1 MiB per frame toward the extension (Chrome's limit).

**Windows named pipe DACL.**

- libuv creates the pipe with the default DACL. On the Windows CI runner (an elevated administrator), the observed DACL is:
  - SYSTEM and Administrators: full control.
  - Everyone and Anonymous: read only (`0x120089`).
  - Owner: Administrators. An elevated administrator's objects are owned by Administrators rather than by the user.
- The Windows CI test asserts three things:
  - Only the current user, SYSTEM, Administrators and the creator owner hold any write right.
  - The owner is the current user or Administrators.
  - At least one writer exists.
- Read-only access cannot send `hello`, so it cannot reach the handshake. A tighter DACL, without Everyone and Anonymous read, needs a native addon and is deferred (see Still to validate).

**Unix socket.**

- The socket's directory must be mode 0700, owned by the current user, and not a symlink.
- A stale socket file is removed. If another server is still listening on the path, startup fails with `EADDRINUSE`.

## Consequences

- One Noise library runs in Node, the extension and the plugin. The browser build needs `sodium-javascript`.
- The extension's key protection is weaker than ADR 0006 hoped, as stated above.
- Pairing UX is reversed: the code appears in the client, and the user types it in the desktop. M1-08 (extension UI) and M2 (desktop UI) must follow this.
- Desktop key storage through `safeStorage` and a persistent client registry land in M2. M1-06 ships an in-memory registry.

## Still to validate

- WebCrypto X25519 in the minimum Chrome, Edge and Obsidian versions. This only matters if a future library takes an async DH callback; we would then move off the wrapped key.
- A named pipe DACL without Everyone read access (needs a native addon or a pipe created by Electron in M2).
- The browser bundle and service-worker run, inside the real extension (M1-08).
