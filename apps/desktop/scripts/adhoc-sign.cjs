// afterSign hook: ad-hoc sign the macOS app so the unsigned preview is launchable (Apple Silicon refuses
// unsigned code) and its integrity is verifiable (`codesign --verify --deep --strict`).
// electron-builder skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false (as in CI), and Electron's own
// prebuilt signature is invalidated by the Info.plist/ASAR-integrity and fuse edits made at packaging time.
// This runs after those edits and before the dmg/zip are built, so the signature covers the final bundle.
// Real Developer ID signing and notarization are M5-02; this hook is then replaced by the real identity.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
