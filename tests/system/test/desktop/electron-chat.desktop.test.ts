import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	eventually,
	installFakeAcpProvider,
	makeTemporaryDirectory,
} from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	createSystemConversation,
	initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { launchElectronApp } from "../../src/electron-app.ts";
import { startHeadlessServer } from "../../src/headless-server.ts";
import { connectSystemRpc } from "../../src/rpc-client.ts";

describe("built Electron application", () => {
	it("boots, sends a real chat turn, and restores the transcript after relaunch", async () => {
		const temporary = makeTemporaryDirectory("zuse-electron-system-");
		const repository = join(temporary.path, "repository");
		initializeSystemRepository(repository);
		const server = await startHeadlessServer({ root: temporary.path });
		const rpc = await connectSystemRpc(server.endpoint);
		const provider = installFakeAcpProvider({ root: temporary.path });
		let electron: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
		try {
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

			electron = await launchElectronApp({
				root: temporary.path,
				userData: server.userData,
				providerBinDirectory: provider.binDirectory,
			});
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
			electron = await launchElectronApp({
				root: temporary.path,
				userData: server.userData,
				providerBinDirectory: provider.binDirectory,
			});
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
		} finally {
			await electron?.close().catch(() => undefined);
			await rpc.dispose().catch(() => undefined);
			await server.stop().catch(() => undefined);
			temporary.dispose();
		}
	}, 90_000);

	it("cold-starts the renderer and creates the production database", async () => {
		const temporary = makeTemporaryDirectory("zuse-electron-smoke-");
		const userData = join(temporary.path, "user-data");
		const provider = installFakeAcpProvider({ root: temporary.path });
		let electron: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
		try {
			electron = await launchElectronApp({
				root: temporary.path,
				userData,
				providerBinDirectory: provider.binDirectory,
			});
			await electron.page.locator("body").waitFor({ state: "visible" });
			await eventually(
				() => existsSync(join(userData, "zuse.sqlite")),
				(value) => value,
				"Electron production database creation",
			);
			expect(electron.errors).toEqual([]);
		} catch (cause) {
			const artifact = await electron?.captureFailure("electron-cold-start");
			throw new Error(
				`${cause instanceof Error ? cause.message : String(cause)}${artifact === undefined ? "" : `\nartifact: ${artifact}`}`,
			);
		} finally {
			await electron?.close().catch(() => undefined);
			temporary.dispose();
		}
	}, 45_000);
});
