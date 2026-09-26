// @vitest-environment jsdom
import { ExtensionId, ExtensionListItem } from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import { emptyCollector } from "../../src/lib/extension-client-lifecycle.ts";
import { evaluateExtension } from "../../src/lib/extension-evaluator.ts";
import { ExtensionRegistry } from "../../src/lib/extension-registry.tsx";

vi.mock("../../src/lib/extension-client-bus.ts", () => ({
	useExtensionCatalog: vi.fn(),
}));
vi.mock("../../src/lib/extension-evaluator.ts", () => ({
	evaluateExtension: vi.fn(),
}));

it("keeps the working registration on failure and only disposes it after a successful replacement", async () => {
	const id = ExtensionId.make("reload-fixture");
	const dispose = vi.fn(async () => {});
	const original = {
		extensionId: id,
		bundle: "first",
		contributions: emptyCollector(),
		error: null,
		dispose,
	};
	vi.mocked(evaluateExtension)
		.mockResolvedValueOnce(original)
		.mockRejectedValueOnce(new Error("bad candidate"));
	const registry = new ExtensionRegistry();
	const item = ExtensionListItem.make({
		id,
		manifest: {
			schemaVersion: 1,
			id,
			name: "Fixture",
			description: "Fixture",
			version: "1.0.0",
			entry: "index.ts",
			zuseApi: "^1.0.0",
			capabilities: [],
			contributions: [],
			publisher: { name: "Tests" },
		},
		source: { _tag: "directory", path: "/fixture" },
		status: "running",
		enabled: true,
		grantedCapabilities: [],
		activeCommit: null,
		availableCommit: null,
		error: null,
		providers: [],
		clientBundle: "first",
		clientCss: "",
	});
	const sync = (bundle: string) =>
		new Promise<void>((resolve) => {
			const unsubscribe = registry.subscribe(() => {
				unsubscribe();
				resolve();
			});
			registry.sync({
				globallyEnabled: true,
				items: [{ ...item, clientBundle: bundle }],
			});
		});
	await sync("first");
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await sync("bad");
		expect(registry.getSnapshot()[0]?.contributions).toBe(
			original.contributions,
		);
		expect(registry.getSnapshot()[0]?.error).toContain("bad candidate");
		expect(dispose).not.toHaveBeenCalled();
		vi.mocked(evaluateExtension).mockImplementationOnce(async () => {
			expect(dispose).not.toHaveBeenCalled();
			return {
				...original,
				bundle: "next",
				contributions: emptyCollector(),
				dispose: async () => {},
			};
		});
		await sync("next");
		expect(dispose).toHaveBeenCalledOnce();
		expect(registry.getSnapshot()[0]?.error).toBeNull();
	} finally {
		error.mockRestore();
	}
});
