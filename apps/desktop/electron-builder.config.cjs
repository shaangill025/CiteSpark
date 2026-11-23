// electron-builder configuration (ADR 0001, ADR 0009). Builds unsigned preview installers locally and in CI.
// Nothing is published: `publish: null` here and `--publish never` in the script. Signing, notarization and
// update feeds are M5-02 (owner decision Q1; docs/f0/blockers.md B2).
/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "org.citspark.desktop",
  productName: "Citspark",
  copyright: "Copyright Citspark contributors",
  electronVersion: "45.3.4",
  directories: {
    // Staged by scripts/build.mjs: bundled code, the renderer, the platform's prebuilt SQLite addon and a
    // package.json without dependencies.
    app: "build/app",
    output: "build/release",
    buildResources: "build-resources",
  },
  files: ["**/*"],
  asar: true,
  asarUnpack: ["prebuilds/**"],
  // The staged app has no node_modules. Returning false tells electron-builder that node_modules are handled
  // outside it, so it neither rebuilds native modules nor collects the workspace's dependencies (it would
  // otherwise fall back to the pnpm workspace and copy development packages and sources into the app).
  beforeBuild: async () => false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  includePdb: false,
  afterSign: require("node:path").join(__dirname, "scripts", "adhoc-sign.cjs"),
  publish: null,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    // macOS and Windows only: electron-builder records the asar header hash (Info.plist ElectronAsarIntegrity /
    // the Windows Integrity resource) and Electron refuses a modified app.asar. Linux has no such check.
    enableEmbeddedAsarIntegrityValidation: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: [{ target: "dmg" }, { target: "zip" }],
    category: "public.app-category.productivity",
    // Ad-hoc signature only (Apple Silicon refuses unsigned code); no Developer ID, no notarization.
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: { writeUpdateInfo: false },
  win: { target: [{ target: "nsis" }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: false,
  },
  linux: {
    target: [{ target: "AppImage" }, { target: "tar.gz" }],
    category: "Office",
    maintainer: "Citspark contributors",
  },
};
