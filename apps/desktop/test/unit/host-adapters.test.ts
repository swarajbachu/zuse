import { readdir, readFile } from "node:fs/promises";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createBrowserCookieHostAdapter } from "../../src/host/browser-cookie.ts";
import {
	parseLsofListeners,
	parseNetstatListeners,
	parseSsListeners,
} from "../../src/host/local-port-inspector.ts";

describe("browser cookie host adapter", () => {
	it("discovers XDG, Snap, and Flatpak Chromium profiles on Linux", () => {
		const adapter = createBrowserCookieHostAdapter({
			platform: "linux",
			home: "/home/tester",
			env: { XDG_CONFIG_HOME: "/data/config" },
		});

		expect(adapter.profileSearchRoots).toContain("/data/config");
		expect(adapter.profileSearchRoots).toContain(
			"/home/tester/snap/chromium/common/chromium",
		);
		expect(adapter.profileSearchRoots).toContain(
			"/home/tester/.var/app/org.chromium.Chromium/config",
		);
		expect(adapter.normalizeDefaultBrowserId("google-chrome.desktop\n")).toBe(
			"google chrome",
		);
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

describe("local listener parsers", () => {
	it("parses Linux ss output and deduplicates ports", () => {
		const result = parseSsListeners(
			[
				'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=1))',
				'LISTEN 0 128 [::1]:8080 [::]:* users:(("bun",pid=13,fd=2))',
				'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3))',
			].join("\n"),
		);
		expect(result).toEqual([
			{ name: "node", port: 3000 },
			{ name: "bun", port: 8080 },
		]);
	});

	it("keeps the existing macOS and Windows parser contracts", () => {
		expect(
			parseLsofListeners(
				"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 u 1u IPv4 1 0t0 TCP 127.0.0.1:4173",
			),
		).toEqual([{ name: "node", port: 4173 }]);
		expect(
			parseNetstatListeners(
				"  TCP    127.0.0.1:9229    0.0.0.0:0    LISTENING",
			),
		).toEqual([{ name: "localhost", port: 9229 }]);
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
