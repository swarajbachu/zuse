import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeAcpProvider } from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { launchElectronApp } from "../../src/electron-app.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("built Electron Git workspace", () => {
	it("streams external working-tree edits into the open Changes panel", async () => {
		await withSystemTest("zuse-electron-git-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const readme = join(repository, "README.md");
			const cleanContents = readFileSync(readme, "utf8");
			const server = await scope.server();
			const rpc = await scope.rpc(server.endpoint);
			const provider = installFakeAcpProvider({ root: scope.root });
			await Effect.runPromise(
				rpc.client["settings.update"]({
					patch: {
						onboardingCompleted: true,
						defaultProviderId: "gemini",
						defaultAutoCreateWorktree: false,
					},
				}),
			);
			const { folder, conversation } = await createSystemConversation(
				rpc.client,
				repository,
			);
			await Effect.runPromise(
				rpc.client["workspace.setSelected"]({ folderId: folder.id }),
			);
			await rpc.dispose();
			await server.stop();

			const electron = await scope.acquire(
				() =>
					launchElectronApp({
						root: scope.root,
						userData: server.userData,
						providerBinDirectory: provider.binDirectory,
					}),
				(value) => value.close(),
			);
			const page = electron.page;
			await electron.app.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows()[0]?.setSize(1_600, 900);
			});
			await page
				.getByText(conversation.chat.title, { exact: true })
				.first()
				.click();
			const summaryToggle = page.getByRole("button", {
				name: "Toggle environment summary",
			});
			if ((await summaryToggle.getAttribute("aria-pressed")) !== "true") {
				await summaryToggle.click();
			}
			const summary = page.getByRole("complementary", {
				name: "Environment summary",
			});
			await summary.getByRole("button", { name: /changes/i }).click();
			const changedFile = page.getByRole("button", {
				name: "Open changes for README.md",
				exact: true,
			});
			await expect.poll(() => changedFile.count()).toBe(0);

			writeFileSync(readme, `${cleanContents}external edit\n`);
			try {
				await changedFile.waitFor({ state: "visible", timeout: 10_000 });
			} catch (cause) {
				const artifact = await electron.captureFailure(
					"electron-git-external-edit",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\n${electron.diagnostics()}`,
				);
			}

			writeFileSync(readme, cleanContents);
			await expect.poll(() => changedFile.count(), { timeout: 10_000 }).toBe(0);
			expect(electron.errors).toEqual([]);
		});
	}, 60_000);
});
