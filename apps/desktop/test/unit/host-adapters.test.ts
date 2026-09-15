import { readdir, readFile } from "node:fs/promises";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createBrowserCookieHostAdapter } from "../../src/host/browser-cookie.ts";
import {
  ghosttyWorkingDirectoryArgs,
  listPortableOpenTargets,
  terminalShellCommand,
} from "../../src/host/open-targets.ts";

describe("Linux open targets", () => {
  it("passes Ghostty's working directory as one option", () => {
    expect(ghosttyWorkingDirectoryArgs("/tmp/a repo")).toEqual(["--working-directory=/tmp/a repo"]);
  });

  it("opens the portable terminal in the requested directory", () => {
    expect(terminalShellCommand("/tmp/a repo")).toEqual([
      "-e",
      "sh",
      "-c",
      `cd -- "$1" && exec "\${SHELL:-/bin/sh}" -l`,
      "zuse-terminal",
      "/tmp/a repo",
    ]);
  });
});

describe("Windows open targets", () => {
  it("exposes File Explorer, editors, and Windows Terminal", async () => {
    const targets = await listPortableOpenTargets("win32");
    expect(targets.map(({ id }) => id)).toEqual([
      "finder",
      "cursor",
      "vscode",
      "windsurf",
      "terminal",
    ]);
    expect(targets[0]).toMatchObject({
      id: "finder",
      label: "File Explorer",
      available: true,
    });
  });
});

describe("browser cookie host adapter", () => {
  it("discovers XDG, Snap, and Flatpak Chromium profiles on Linux", () => {
    const adapter = createBrowserCookieHostAdapter({
      platform: "linux",
      home: "/home/tester",
      env: { XDG_CONFIG_HOME: "/data/config" },
    });

    expect(adapter.profileSearchRoots).toContain("/data/config");
    expect(adapter.profileSearchRoots).toContain("/home/tester/snap/chromium/common/chromium");
    expect(adapter.profileSearchRoots).toContain(
      "/home/tester/.var/app/org.chromium.Chromium/config",
    );
    expect(adapter.normalizeDefaultBrowserId("google-chrome.desktop\n")).toBe("google chrome");
    expect(adapter.decryptionKeys(null)).toHaveLength(1);
    expect(adapter.decryptionKeys("secret")).toHaveLength(2);
  });

  it("leaves Windows browser import explicitly unimplemented", () => {
    const adapter = createBrowserCookieHostAdapter({
      platform: "win32",
      home: "C:\\Users\\tester",
    });
    expect(adapter.profileSearchRoots).toEqual([]);
    expect(adapter.defaultBrowserCommand).toBeNull();
    expect(adapter.decryptionKeys("secret")).toEqual([]);
  });
});

const rendererFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = Path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await rendererFiles(path)));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files;
};

describe("renderer host boundary", () => {
  it("does not infer the operating system from browser globals", async () => {
    const root = Path.resolve(
      Path.dirname(fileURLToPath(import.meta.url)),
      "../../../renderer/src",
    );
    const violations: string[] = [];
    for (const path of await rendererFiles(root)) {
      const source = await readFile(path, "utf8");
      if (/navigator\.(?:platform|userAgent)/u.test(source))
        violations.push(Path.relative(root, path));
    }
    expect(violations).toEqual([]);
  });
});
