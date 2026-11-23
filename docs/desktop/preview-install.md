# Desktop shell preview: build, install and known risks (M2-01)

Requirements: Q09, Q23, SEC-06 (owner decision Q1, [blockers](../f0/blockers.md) B1, B2, B11).

## What this preview is

The M2-01 desktop app is an **Electron shell only**. It starts the Citspark core in a supervised utility process,
creates an empty local library and shows the core's health (state, library schema version, process ID) with a
"Check core status" button and a "Try again" button after a failure. That is all it does.

There are **no capture, import, search, sync, pairing, backup or AI screens**, and no feature can be used end to
end. The window says "Preview build: not usable yet". Do not use it with a library you care about.

- **No published download.** Nothing is released, published or uploaded. CI builds installers to check that they
  build, then discards them; CI uploads only test reports, screenshots and installer checksums.
- **Unsigned.** Windows and Linux builds are unsigned. macOS builds carry only an ad-hoc signature (Apple Silicon
  refuses to run unsigned code); there is no Apple Developer ID signature and no notarization. Signed builds are
  M5-02 (owner decision Q1).
- **Default icon.** The app uses Electron's default icon; artwork is not release-blocking.
- **Not yet tested:** installation on clean virtual machines without developer tools, idle memory on the 8 GB
  reference machine, screen readers, and the four-platform CI run (see [Verification status](#verification-status)).

## Build the preview from source

Building needs developer tools (Node.js 24 and pnpm 10.21.0, pinned in `.nvmrc` and `packageManager`). The installed
app itself bundles its runtime and does not need Node.js; that has been checked only by launching a copy of the
packaged app with a reduced environment, not yet on a clean machine.

```sh
pnpm install --frozen-lockfile
pnpm --filter @citspark/desktop exec install-electron  # download the pinned Electron runtime (see below)
pnpm build
pnpm --filter @citspark/desktop build          # stage the app in apps/desktop/build/app
pnpm --filter @citspark/desktop e2e            # Playwright against the real Electron runtime (optional)
pnpm --filter @citspark/desktop dist           # electron-builder --publish never, into apps/desktop/build/release
pnpm --filter @citspark/desktop smoke:packaged # launches a copy of the packaged app with isolated synthetic data
```

`pnpm install` does not download the Electron runtime: the pinned `electron` package declares no install script,
and Electron is not in `onlyBuiltDependencies` (`pnpm-workspace.yaml`), so pnpm would not run one anyway. Do not
add it there; run the download explicitly instead. `install-electron` is the
`electron` package's own downloader; it fetches the version pinned in `apps/desktop/package.json` and checks it
against the package's checksums. CI runs the same command. Without it, `e2e` cannot find the Electron binary.

On Linux without a display, prefix the `e2e` and `smoke:packaged` commands with `xvfb-run -a`.

`dist` builds for the machine it runs on:

| Platform | Output in `apps/desktop/build/release` |
| --- | --- |
| macOS (Apple silicon or Intel) | `.dmg` and `.zip`, plus the unpacked `mac-arm64/` or `mac/` app |
| Windows x64 | NSIS installer `.exe` (per-user, installation folder selectable), plus `win-unpacked/` |
| Linux x64 | `.AppImage` and `.tar.gz`, plus `linux-unpacked/` |

Record the checksum of what you built so you can compare it on the machine you install on:

```sh
shasum -a 256 apps/desktop/build/release/*.dmg   # macOS; use sha256sum on Linux and Git Bash
```

On Windows PowerShell: `Get-FileHash -Algorithm SHA256 "apps\desktop\build\release\*.exe"`.

## Before installing a copy you did not build

Only install a preview from someone you trust, and only after checking it:

1. Get the SHA-256 checksum through a channel other than the one the installer came from, and compare it with
   `shasum -a 256 <file>` (macOS), `sha256sum <file>` (Linux) or `Get-FileHash -Algorithm SHA256 <file>` (Windows).
   Do not install on a mismatch.
2. Prefer building from source at a commit you have read. The installer contains the code in `apps/desktop` and the
   workspace packages it bundles; third-party notices ship as `THIRD_PARTY_NOTICES.txt` inside the app.
3. Understand the unsigned risk: without a publisher signature the operating system cannot tell you who built the
   file or whether it changed after it was built. The checksum comparison is the only integrity check.

Never turn off Gatekeeper or SmartScreen for the whole system to install Citspark. The steps below approve this one
app only.

## macOS

1. Open the `.dmg` and drag Citspark to Applications (or unzip the `.zip`).
2. Open Citspark. A copy downloaded from the internet is quarantined, so macOS refuses it because it is not
   notarized.
3. Open **System Settings > Privacy & Security**. Under Security, find the message about Citspark and choose
   **Open Anyway**, then confirm with your password. This approves only this copy of Citspark.

A copy you built on the same Mac is not quarantined and opens directly. To inspect the signature:
`codesign --verify --deep --strict --verbose=2 /Applications/Citspark.app` reports a valid ad-hoc signature (no team
identifier); `spctl --assess` rejects it because it is not notarized. That rejection is expected for this preview.

## Windows

1. Run the `Citspark Setup <version>.exe` installer. Choose the option to install for the current user only ("Only
   for me"); that needs no administrator rights. You can also choose the installation folder.
2. If Microsoft Defender SmartScreen shows "Windows protected your PC" (an unknown publisher), choose **More info**,
   check that the file name is the one whose checksum you verified, then choose **Run anyway**. This applies to this
   file only.
3. Remove it later from **Settings > Apps > Installed apps**.

## Linux

AppImage (x64):

```sh
chmod +x Citspark-*.AppImage
./Citspark-*.AppImage
```

AppImages need FUSE 2 (`libfuse2t64` on Ubuntu 24.04, `libfuse2` on older releases). The `.tar.gz` contains the same
unpacked app; run `./citspark` from the extracted folder.

**Known sandbox issue (untested on clean machines):** Chromium's sandbox needs unprivileged user namespaces. Ubuntu
23.10 and later restrict these per application through AppArmor, so an unsigned app without its own AppArmor profile
can fail to start with a sandbox error. Do **not** run Citspark with `--no-sandbox`, and do not turn the restriction
off for the whole system. Safe per-app options:

- Add an AppArmor profile that grants `userns` to the Citspark executable only (the same approach Ubuntu uses for
  browsers), for example `/etc/apparmor.d/citspark` for an extracted `.tar.gz` in `/opt/citspark`:

  ```text
  abi <abi/4.0>,
  include <tunables/global>

  profile citspark /opt/citspark/citspark flags=(unconfined) {
    userns,
  }
  ```

  then load it with `sudo apparmor_parser -r /etc/apparmor.d/citspark`.
- For an extracted `.tar.gz`, Electron's setuid sandbox helper can be used instead:
  `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in the extracted folder.

The CI job installs a profile of the first kind for its own test copies only; see
[the desktop workflow](../../.github/workflows/desktop.yml).

## Where data goes and how to remove it

The app keeps its library under Electron's per-user data folder, in `library/library.sqlite`:

- macOS: `~/Library/Application Support/Citspark`
- Windows: `%APPDATA%\Citspark`
- Linux: `~/.config/Citspark`

Uninstalling the app does not delete this folder; delete it yourself if you no longer need it. The preview makes no
network requests of its own (the E2E suite routes Chromium through a recording proxy and asserts zero connections).

## Verification status

| Check | Status |
| --- | --- |
| Unit tests, desktop E2E (8 tests), unsigned `dist`, packaged smoke | Passed locally on macOS arm64 only |
| Ad-hoc signature of the macOS app (`codesign --verify --deep --strict`) | Passed locally on macOS arm64 |
| Desktop build, E2E, installers and packaged smoke on Ubuntu, Windows, macOS arm64 and macOS Intel CI runners | Workflow added ([desktop.yml](../../.github/workflows/desktop.yml)); **not yet run** |
| Install on clean VMs without developer tools (T14) | Not tested (M2-01 acceptance, B1) |
| Idle memory on the 8 GB reference machine (DAT-02, B11) | Not measured; CI and local runs record host memory only |
| Screen readers (ACC-01, ACC-02, T13) | Not tested |
| Developer ID signing, notarization, Windows code signing, update channel | Not done (M5-02) |
