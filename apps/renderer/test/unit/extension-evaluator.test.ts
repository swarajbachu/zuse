// @vitest-environment jsdom
import { ExtensionId, ExtensionListItem } from "@zuse/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { withExtensionDeadline } from "../../src/lib/extension-client-lifecycle.ts";
import { evaluateExtension } from "../../src/lib/extension-evaluator.ts";

vi.mock("../../src/lib/extension-desktop-host.ts", () => ({
	createExtensionDesktopHost: () => ({}),
}));
vi.mock("@repo/ui/dither", () => ({}));
vi.mock("@repo/ui/button", () => ({}));
vi.mock("@repo/ui/card", () => ({}));
vi.mock("@repo/ui/code", () => ({}));
vi.mock("@hugeicons/react", () => ({}));
vi.mock("@zuse/extension-sdk/client", () => ({}));

afterEach(() => {
	vi.useRealTimers();
});

it("evaluates the deferred extension and removes its styles even when cleanup fails", async () => {
	const id = ExtensionId.make("test-extension");
	const clientBundle = `require => ({ default: context => { context.addCommand({ id: "hello", title: "Hello", run: () => {} }); return () => { throw new Error("cleanup failed"); }; } })`;
	const item = ExtensionListItem.make({
		id,
		manifest: {
			schemaVersion: 1,
			id,
			name: "Test",
			description: "Test",
			version: "1.0.0",
			entry: "index.ts",
			zuseApi: "^1.1.0",
			contributions: ["command"],
			capabilities: ["ui"],
			publisher: { name: "Tests" },
		},
		source: { _tag: "directory", path: "/test" },
		status: "running",
		enabled: true,
		grantedCapabilities: ["ui"],
		activeCommit: null,
		availableCommit: null,
		error: null,
		providers: [],
		clientBundle,
		clientCss: ".test { color: red; }",
	});
	const registration = await evaluateExtension({ ...item, clientBundle });
	expect(registration.contributions.commands[0]?.id).toBe("hello");
	expect(
		document.querySelector("style[data-zuse-extension='test-extension']"),
	).not.toBeNull();
	await expect(registration.dispose()).rejects.toThrow("cleanup failed");
	expect(
		document.querySelector("style[data-zuse-extension='test-extension']"),
	).toBeNull();
});

it("bounds a stalled client import and clears the deadline after success", async () => {
	vi.useFakeTimers();
	const pending = withExtensionDeadline(
		new Promise<never>(() => {}),
		5000,
		"Client loading timed out",
	);
	const rejected = expect(pending).rejects.toThrow("Client loading timed out");
	await vi.advanceTimersByTimeAsync(5000);
	await rejected;
	await expect(
		withExtensionDeadline(Promise.resolve("ready"), 5000, "timeout"),
	).resolves.toBe("ready");
	expect(vi.getTimerCount()).toBe(0);
});
