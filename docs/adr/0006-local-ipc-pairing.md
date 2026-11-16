# 0006. Local IPC and client pairing

Status: Decided.
Requirements: PLG-01, PLG-02, SEC-04, SEC-07, Q54, Q55, T06, §14 (API contract)

## Context

The extension and the Obsidian plugin talk to the desktop on the same computer. Pairing must be explicit, each client gets a separate revocable credential with limited permissions (Q54), and incompatible clients must be blocked safely (Q55). Unauthorized local clients are in the threat model (SEC-07). T06 requires that unpaired, revoked, wrong-origin, wrong-scope, replayed, and incompatible clients cannot read or mutate anything. "It is on localhost" is not an authentication.

## Options

| Criterion | Localhost HTTP or WebSocket with bearer token | Native messaging plus local socket with per-client keys |
|---|---|---|
| Who can connect | Any local process and, without care, any web page (DNS rebinding, `fetch` to `127.0.0.1`). | Extension: only extension IDs listed in the native messaging host manifest, launched by the browser. Socket: only the current OS user (0700 directory or pipe ACL). |
| Browser friction | Chrome Local Network Access prompts for local-network requests from pages. Whether extension requests are exempt is unverified. | Native messaging is a stable extension API in Chrome and Edge. |
| Credential at rest | Bearer token, replayable if copied. | Per-client static key pair, private key never leaves the client's key store. Copying the public key grants nothing. |
| Obsidian plugin | `fetch` works. | Node `net` module works in the desktop Obsidian app. |
| Port conflicts | Must pick and publish a port. | None. |

## Decision

**Transport**

- The desktop core listens on a Unix domain socket in a per-user app directory with mode 0700 (macOS, Linux), or a named pipe with a DACL for the current user only (Windows).
- Browser extension: Chrome and Edge native messaging. The host manifest's `allowed_origins` lists the exact Citspark extension IDs (no wildcards are allowed by Chrome). The small host binary checks the caller origin that Chrome passes as its first argument, then relays frames to the socket. It keeps no state.
- Obsidian plugin: connects to the socket directly with Node `net`.
- Renderer: talks to the core through Electron's `MessagePort`, using the same protocol schemas.

**Framing and versioning**

- 4-byte length prefix plus a UTF-8 JSON body, validated with zod schemas from `packages/protocol`. Native messaging limits frames from the host to 1 MB, so large results are paged.
- The first frame is `hello` with protocol version range, client kind, and client version. The core answers with the chosen version or a structured `incompatible` error that the client must display (PLG-02, Q55). `hello` and the reply travel before the handshake and are bound into it as the Noise prologue, so tampering with them makes the handshake fail.
- Every mutation carries a request ID for idempotency. Streams carry sequence numbers and a terminal state, and reconnecting never repeats a mutation (§14 API contract).

**Channel security**

The socket only proves the peer runs as the same OS user. Another process running as that user could take over the socket path or relay a real client's handshake and then inject its own frames. Signing a nonce alone does not stop that relay. So every connection runs inside a mutually authenticated, encrypted channel:

- Handshake: the Noise Protocol Framework with X25519, ChaCha20-Poly1305 and BLAKE2s. Use a maintained implementation, never our own. The library choice is PROPOSED; the candidates are in `docs/f0/license-inventory.md`.
- Both the desktop and each client have a static X25519 key pair. The desktop's private key lives in the OS credential store through Electron `safeStorage`.
- Every frame after the handshake is encrypted and authenticated with the session keys. A relay that holds neither private key can forward bytes but cannot read, change, inject, or reorder frames.

**Pairing (Noise XX with a short authentication string)**

1. The user starts pairing in the client. The client creates its static key pair and runs a Noise XX handshake with the desktop, which exchanges both static public keys.
2. The desktop shows a pairing dialog with the client kind, the requested scopes, and a 6-digit code. The code is derived from the handshake hash.
3. The user types the code into the client. The client derives the code from its own handshake hash and compares it with what the user typed. If someone sat in the middle, the two handshake hashes differ and so do the codes. The client then sends a `pair.confirm` frame inside the channel.
4. Codes are single-use, expire after 2 minutes, and lock pairing after 5 wrong attempts.
5. The desktop stores the client ID, the client's static public key, scopes, and creation time. The client stores the desktop's static public key. Neither side stores a shared secret (SEC-04).

**Every connection (Noise KK)**

- Both sides already know each other's static public key, so they run Noise KK. The handshake fails unless both sides hold their paired private keys. The desktop then attaches the stored scopes to the connection.
- Each handshake uses fresh ephemeral keys, so a recorded session cannot be replayed (T06).
- Scopes (initial set): `capture.write`, `import.write`, `sync.read`, `sync.resolve`, `search.read`, `answer.run`, `research.run`, `clients.manage` (desktop UI only). Each handler checks scope before doing anything.
- Revocation deletes the client's public key and closes that client's open connections at once.

**Client key storage**

- Extension: a non-extractable WebCrypto X25519 `CryptoKey` in the extension's IndexedDB. The Noise library must accept a key-agreement callback so the raw private key is never exported.
- Obsidian plugin: the same approach, using the IndexedDB of Obsidian's Electron renderer, which is per app profile and outside the vault. Never write key material to the plugin's `data.json`. That file lives at `<vault>/.obsidian/plugins/<id>/data.json` and is often copied by vault sync tools or committed to git.
- T06 and the credential scanner (SEC-04) search the vault and backups for key material.

## Consequences

- The extension requires a host manifest per browser and OS (registry keys on Windows; files under `NativeMessagingHosts` on macOS and Linux). The installer writes and removes them.
- A process running as the same OS user can reach the socket and can relay traffic, but without a paired private key it cannot complete a handshake or read or inject frames. A process that can read the client's key store, or debug the client or desktop process, defeats this. A fully compromised user account is outside the guarantee (SEC-07).
- Adds a Noise library dependency to the desktop, the extension, and the plugin.
- Pairing moves into M1 because capture needs it. See `docs/f0/implementation-plan.md`.

## Still to validate

- T06 suite in M1-06: unpaired, revoked, wrong origin, wrong scope, replayed handshake, relayed and injected frames, incompatible version.
- Named pipe DACL behavior on Windows (Windows CI runner, M1-06).
- A maintained Noise implementation that works in an MV3 service worker, in Node, and in Obsidian's renderer, and that accepts a WebCrypto key-agreement callback. If none exists, fall back to storing the raw client private key wrapped by a non-extractable WebCrypto AES-GCM key, and record the weaker property.
- WebCrypto X25519 support in the minimum supported Chrome, Edge, and Obsidian (Electron) versions.
- Native messaging carries Noise frames. The host binary relays ciphertext only.
