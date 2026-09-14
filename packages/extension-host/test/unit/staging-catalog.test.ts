import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { MARKETPLACE_PUBLIC_KEY } from "../../src/catalog-key.ts";
import { ExtensionHost } from "../../src/host.ts";
import { verifyMarketplaceCatalog } from "../../src/marketplace.ts";
import {
	STAGING_MARKETPLACE_BASE_URL,
	STAGING_MARKETPLACE_PUBLIC_KEY,
} from "../../src/staging-catalog.ts";

it("installs all three signed staging artifacts without source checkout installation", async () => {
	const directory = resolve(
		import.meta.dirname,
		"../../../..",
		"apps/web/public/extensions/staging",
	);
	const catalogBytes = await readFile(join(directory, "catalog.v1.json"));
	const signatureBase64 = await readFile(
		join(directory, "catalog.v1.sig"),
		"utf8",
	);
	expect(() =>
		verifyMarketplaceCatalog({
			catalogBytes,
			signatureBase64,
			publicKeyPem: MARKETPLACE_PUBLIC_KEY,
		}),
	).toThrow("signature");
	const catalog = verifyMarketplaceCatalog({
		catalogBytes,
		signatureBase64,
		publicKeyPem: STAGING_MARKETPLACE_PUBLIC_KEY,
	});
	expect(catalog.entries.map((entry) => entry.manifest.id)).toEqual([
		"test-reports",
		"project-playbook",
		"code-follow-ups",
	]);
	const root = await mkdtemp(join(tmpdir(), "zuse-staging-install-"));
	const host = new ExtensionHost({
		rootDirectory: join(root, "host"),
		secretStore: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
		marketplace: {
			catalogUrl: `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.json`,
			signatureUrl: `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.sig`,
			publicKeyPem: STAGING_MARKETPLACE_PUBLIC_KEY,
		},
		fetch: async (input) => {
			const url = String(input);
			if (url === `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.json`)
				return new Response(catalogBytes);
			if (url === `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.sig`)
				return new Response(signatureBase64);
			const entry = catalog.entries.find((entry) => entry.archiveUrl === url);
			if (!entry) throw Error("Unexpected download");
			expect(url).toMatch(/\/zuse\/[a-f0-9]{40}\//);
			return new Response(
				await readFile(join(directory, "artifacts", `${entry.sha256}.json`)),
			);
		},
	});
	try {
		await writeFile(
			join(root, "report.xml"),
			'<testsuite><testcase name="payment"><failure>declined</failure></testcase></testsuite>',
		);
		await writeFile(join(root, "notes.md"), "# Recovery\nRevert deployment.");
		await writeFile(join(root, "code.ts"), "// TODO: add refunds");
		await host.start();
		await host.execute({ _tag: "set-global-enabled", enabled: true });
		for (const entry of catalog.entries)
			await host.execute({
				_tag: "install",
				source: { _tag: "marketplace", catalogId: entry.manifest.id },
				grantedCapabilities: entry.manifest.capabilities,
			});
		const context = { projectId: "test", workspacePath: root, sessionId: null };
		for (const [id, action, path, title] of [
			["test-reports", "read", "report.xml", "FAILED: payment"],
			["project-playbook", "read", "notes.md", "Recovery"],
			["code-follow-ups", "scan", "", "TODO: add refunds"],
		] as const) {
			expect(
				await host.invoke(
					id,
					"workspace-tool",
					{ action, path, query: "", cursor: 0 },
					context,
				),
			).toMatchObject({
				items: expect.arrayContaining([expect.objectContaining({ title })]),
			});
		}
	} finally {
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
