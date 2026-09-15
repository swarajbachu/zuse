import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import { expect, it } from "vitest";
import {
	executeAgentPlugin,
	inspectAgentPlugin,
	listAgentPlugins,
} from "../../src/agent-plugin/manager.ts";

const binary = resolve(
	fileURLToPath(
		new URL("../../../../node_modules/.bin/codex", import.meta.url),
	),
);
it.skipIf(!existsSync(binary))(
	"manages a real native Codex skill plugin in an isolated home without authentication",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "zuse-plugin-test-"));
		let client: CodexAppServerClient | null = null;
		try {
			const home = join(root, "home"),
				repo = join(root, "market");
			await mkdir(home);
			await mkdir(join(repo, ".agents/plugins"), { recursive: true });
			await mkdir(join(repo, ".git"));
			await mkdir(join(repo, "review/.codex-plugin"), { recursive: true });
			await mkdir(join(repo, "review/skills/review"), { recursive: true });
			await writeFile(
				join(repo, ".agents/plugins/marketplace.json"),
				JSON.stringify({
					name: "zuse-fixture",
					plugins: [
						{
							name: "review",
							source: { source: "local", path: "./review" },
							policy: {
								installation: "AVAILABLE",
								authentication: "ON_INSTALL",
							},
						},
					],
				}),
			);
			await writeFile(
				join(repo, "review/.codex-plugin/plugin.json"),
				JSON.stringify({
					name: "review",
					description: "Review a change",
					skills: "./skills",
				}),
			);
			await writeFile(
				join(repo, "review/skills/review/SKILL.md"),
				"---\nname: review\ndescription: Review a diff\n---\nReview the selected diff.",
			);
			client = await CodexAppServerClient.start({
				codexPath: binary,
				env: { ...process.env, CODEX_HOME: home },
				externalAuthProvider: null,
				startupTimeoutMs: 10000,
				onNotification: () => {},
				onServerRequest: (_, respond) => respond({}),
			});
			const timer = setTimeout(() => client?.close(), 15000);
			try {
				await executeAgentPlugin(client, {
					_tag: "add-marketplace",
					source: repo,
				});
				const plugin = { marketplace: "zuse-fixture", name: "review" };
				expect((await listAgentPlugins(client)).plugins).toMatchObject([
					{ installed: false },
				]);
				expect((await inspectAgentPlugin(client, plugin)).skills).toEqual([
					"review:review",
				]);
				await executeAgentPlugin(client, { _tag: "install", plugin });
				expect((await listAgentPlugins(client)).plugins).toMatchObject([
					{ installed: true, enabled: true },
				]);
				await executeAgentPlugin(client, {
					_tag: "set-enabled",
					plugin,
					enabled: false,
				});
				expect((await listAgentPlugins(client)).plugins).toMatchObject([
					{ installed: true, enabled: false },
				]);
				await executeAgentPlugin(client, {
					_tag: "set-enabled",
					plugin,
					enabled: true,
				});
				await executeAgentPlugin(client, { _tag: "uninstall", plugin });
				expect((await listAgentPlugins(client)).plugins).toMatchObject([
					{ installed: false },
				]);
				await executeAgentPlugin(client, {
					_tag: "remove-marketplace",
					marketplace: plugin.marketplace,
				});
				expect((await listAgentPlugins(client)).marketplaces).toEqual([]);
			} finally {
				clearTimeout(timer);
			}
		} finally {
			client?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
