import { describe, expect, test } from "vitest";
import {
  assertDedicatedProfile,
  assertKitOutsideRepo,
  assertSocketPathFits,
  browserExecutable,
  launchCommand,
  layout,
  realUserDataDir,
  type Env,
} from "./paths.ts";

const mac: Env = { platform: "darwin", home: "/Users/o", env: {} };
const linux: Env = { platform: "linux", home: "/home/o", env: {} };
const win: Env = {
  platform: "win32",
  home: "C:\\Users\\o",
  env: { LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
};

describe("real browser data directories (never used by the kit)", () => {
  test.each([
    ["chrome", mac, "/Users/o/Library/Application Support/Google/Chrome"],
    ["edge", mac, "/Users/o/Library/Application Support/Microsoft Edge"],
    ["chrome", linux, "/home/o/.config/google-chrome"],
    ["edge", linux, "/home/o/.config/microsoft-edge"],
    ["chrome", win, "C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\User Data"],
    ["edge", win, "C:\\Users\\o\\AppData\\Local\\Microsoft\\Edge\\User Data"],
  ] as const)("%s on %s", (b, e, dir) => {
    expect(realUserDataDir(b, e)).toBe(dir);
  });
});

describe("layout", () => {
  test("defaults live under ~/.citspark-live-kit, one directory per browser", () => {
    const l = layout({ browser: "edge", env: mac });
    expect(l.browserDir).toBe("/Users/o/.citspark-live-kit/edge");
    expect(l.profileDir).toBe("/Users/o/.citspark-live-kit/edge/profile");
    expect(l.socketPath).toBe("/Users/o/.citspark-live-kit/edge/ipc/core.sock");
  });
  test("Windows uses a per-browser named pipe and backslash paths", () => {
    const l = layout({ browser: "chrome", env: win });
    expect(l.profileDir).toBe("C:\\Users\\o\\.citspark-live-kit\\chrome\\profile");
    expect(l.socketPath).toMatch(/^\\\\\.\\pipe\\citspark-live-kit-chrome-[0-9a-f]+$/);
  });
  test("custom directories are honoured", () => {
    const l = layout({ browser: "chrome", env: linux, kitDir: "/data/kit", profileDir: "/data/p" });
    expect(l.libraryPath).toBe("/data/kit/chrome/library/library.sqlite");
    expect(l.profileDir).toBe("/data/p");
  });
  test("an over-long unix socket path is refused", () => {
    expect(() => assertSocketPathFits("/" + "a".repeat(120), "darwin")).toThrow(/too long/);
    expect(() => assertSocketPathFits("/" + "a".repeat(120), "win32")).not.toThrow();
  });
});

describe("dedicated-profile guard", () => {
  const repo = "/Users/o/src/CiteSpark";
  const check = (profileDir: string, e: Env = mac, browser: "chrome" | "edge" = "chrome") =>
    assertDedicatedProfile({ browser, env: e, profileDir, repoRoot: repo });
  test("accepts a path outside every real browser dir and the repo", () => {
    expect(() => check("/Users/o/.citspark-live-kit/chrome/profile")).not.toThrow();
  });
  test.each([
    "/Users/o/Library/Application Support/Google/Chrome",
    "/Users/o/Library/Application Support/Google/Chrome/Default",
    "/Users/o/Library/Application Support/Microsoft Edge",
    "/Users/o/Library/Application Support",
    "/Users/o/Library",
  ])("refuses %s", (p) => {
    expect(() => check(p)).toThrow(/real/);
  });
  test("refuses a profile inside the repository", () => {
    expect(() => check(`${repo}/profile`)).toThrow(/outside the repository/);
    expect(() => assertKitOutsideRepo(mac, `${repo}/kit`, repo)).toThrow(/outside/);
  });
  test("refuses the real Windows and Linux dirs", () => {
    expect(() => check("/home/o/.config/google-chrome", linux)).toThrow(/real/);
    expect(() =>
      check("C:\\Users\\o\\AppData\\Local\\Microsoft\\Edge\\User Data", win, "edge"),
    ).toThrow(/real/);
  });
});

describe("browser executable and launch command", () => {
  test("picks the first existing candidate per OS", () => {
    expect(browserExecutable("chrome", mac, (p) => p.startsWith("/Applications"))).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(browserExecutable("edge", mac, (p) => p.startsWith("/Applications"))).toBe(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
    expect(browserExecutable("edge", linux, (p) => p === "/opt/microsoft/msedge/msedge")).toBe(
      "/opt/microsoft/msedge/msedge",
    );
    expect(
      browserExecutable("edge", win, (p) => p.includes("Program Files\\Microsoft\\Edge")),
    ).toBe("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(browserExecutable("chrome", mac, () => false)).toBeNull();
  });
  test("the command points the browser at the dedicated profile only", () => {
    expect(
      launchCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/k/p",
        "darwin",
      ),
    ).toBe(
      "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --user-data-dir='/k/p' --no-first-run --no-default-browser-check",
    );
    expect(launchCommand("C:\\x\\chrome.exe", "C:\\k\\p", "win32")).toContain(
      '--user-data-dir="C:\\k\\p"',
    );
  });
});
