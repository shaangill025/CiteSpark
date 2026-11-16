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
| Credential at rest | Bearer token, replayable if copied. | Ed25519 private key, non-extractable. Copying the public key grants nothing. |
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
- The first frame is `hello` with protocol version range, client kind, and client version. The core answers with the chosen version or a structured `incompatible` error that the client must display (PLG-02, Q55).
- Every mutation carries a request ID for idempotency. Streams carry sequence numbers and a terminal state, and reconnecting never repeats a mutation (§14 API contract).

**Pairing**

1. The user starts pairing in the client. The client generates an Ed25519 key pair with WebCrypto, marked non-extractable, and stores it in IndexedDB (extension) or the plugin's data with OS-protected wrapping where available.
2. The client sends `pair.request` with its public key, client kind, and requested scopes. The desktop shows a pairing dialog with a 6-digit code, the client kind, and the scopes.
3. The user types the code into the client. The client returns it with a signature over the code and a desktop nonce. Codes are single-use, expire after 2 minutes, and lock after 5 wrong attempts.
4. The desktop stores the client ID, public key, scopes, and creation time. It never stores a shared secret (SEC-04).

**Every connection**

- After `hello`, the desktop sends a 32-byte random nonce. The client signs `nonce || connection-id || protocol-version`. The desktop verifies the signature against the stored key and attaches the stored scopes to the connection. Replayed signatures fail because each nonce is used once.
- Scopes (initial set): `capture.write`, `import.write`, `sync.read`, `sync.resolve`, `search.read`, `answer.run`, `research.run`, `clients.manage` (desktop UI only). Each handler checks scope before doing anything.
- Revocation deletes the key and closes that client's open connections at once.

## Consequences

- The extension requires a host manifest per browser and OS (registry keys on Windows; files under `NativeMessagingHosts` on macOS and Linux). The installer writes and removes them.
- A process running as the same OS user can read the socket directory. That process still needs a paired private key. A fully compromised user account is outside the guarantee (SEC-07).
- Pairing moves into M1 because capture needs it. See `docs/f0/implementation-plan.md`.

## Still to validate

- T06 suite in the M1 IPC layer: unpaired, revoked, wrong origin, wrong scope, replayed nonce, incompatible version.
- Named pipe DACL behavior on Windows (CI runner, M2 packaging layer).
- Non-extractable key storage inside Obsidian's Electron renderer.
