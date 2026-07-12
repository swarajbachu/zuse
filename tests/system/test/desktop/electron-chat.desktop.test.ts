import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installFakeAcpProvider, waitForFile } from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { launchElectronApp } from "../../src/electron-app.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("built Electron application", () => {
	it("boots, sends a real chat turn, and restores the transcript after relaunch", async () => {
		await withSystemTest("zuse-electron-system-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
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

			let electron = await scope.acquire(
				() =>
					launchElectronApp({
						root: scope.root,
						userData: server.userData,
						providerBinDirectory: provider.binDirectory,
					}),
				(value) => value.close(),
			);
			await electron.page
				.getByText(conversation.chat.title, { exact: true })
				.first()
				.waitFor({ state: "visible", timeout: 20_000 });
			await electron.page
				.getByText(conversation.chat.title, { exact: true })
				.first()
				.click();
			const composer = electron.page
				.locator(".cm-content[contenteditable='true']")
				.last();
			await composer.fill("Electron system message");
			await electron.page.getByRole("button", { name: "Send" }).click();
			try {
				await electron.page
					.getByText("Hello from deterministic provider.", { exact: true })
					.waitFor({ state: "visible", timeout: 20_000 });
			} catch (cause) {
				const artifact = await electron.captureFailure("electron-chat-send");
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text:\n${await electron.page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}
			expect(electron.errors).toEqual([]);

			await electron.close();
			electron = await scope.acquire(
				() =>
					launchElectronApp({
						root: scope.root,
						userData: server.userData,
						providerBinDirectory: provider.binDirectory,
					}),
				(value) => value.close(),
			);
			await electron.page
				.getByText(conversation.chat.title, { exact: true })
				.first()
				.waitFor({ state: "visible", timeout: 20_000 });
			await electron.page
				.getByText(conversation.chat.title, { exact: true })
				.first()
				.click();
			try {
				await electron.page
					.getByText("Hello from deterministic provider.", { exact: true })
					.waitFor({ state: "visible", timeout: 20_000 });
			} catch (cause) {
				const artifact = await electron.captureFailure("electron-chat-restart");
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text after restart:\n${await electron.page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}
			expect(electron.errors).toEqual([]);
		});
	}, 90_000);

	it("cold-starts the renderer and creates the production database", async () => {
		await withSystemTest("zuse-electron-smoke-", async (scope) => {
			const userData = scope.path("user-data");
			mkdirSync(userData, { recursive: true });
			const fileWait = new AbortController();
			scope.defer(() => fileWait.abort());
			const databaseReady = waitForFile(
				join(userData, "zuse.sqlite"),
				20_000,
				fileWait.signal,
			);
			const provider = installFakeAcpProvider({ root: scope.root });
			let electron: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
			try {
				const launch = scope.acquire(
					() =>
						launchElectronApp({
							root: scope.root,
							userData,
							providerBinDirectory: provider.binDirectory,
						}),
					(value) => value.close(),
				);
				[electron] = await Promise.all([launch, databaseReady]);
				await electron.page.locator("body").waitFor({ state: "visible" });
				expect(electron.errors).toEqual([]);
			} catch (cause) {
				const artifact = await electron?.captureFailure("electron-cold-start");
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}${artifact === undefined ? "" : `\nartifact: ${artifact}`}`,
				);
			}
		});
	}, 45_000);
});
