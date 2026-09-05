import { execFileSync } from "node:child_process";
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
			const origin = scope.path("origin.git");
			execFileSync("git", ["clone", "--bare", repository, origin]);
			execFileSync("git", ["remote", "add", "origin", origin], {
				cwd: repository,
			});
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
			await electron.page.keyboard.press("ControlOrMeta+k");
			const quickOpen = electron.page.getByRole("combobox", {
				name: "Search chats and commands",
			});
			await quickOpen.fill(">settings");
			await electron.page.keyboard.press("Enter");
			await expect.poll(() => quickOpen.count()).toBe(0);
			await electron.page.keyboard.press("ControlOrMeta+k");
			await quickOpen.fill(">");
			await electron.page.keyboard.press("Tab");
			await expect
				.poll(() => quickOpen.evaluate((el) => el === document.activeElement))
				.toBe(true);
			await electron.page.keyboard.press("ArrowDown");
			await expect
				.poll(() =>
					electron.page.getByRole("option", { selected: true }).textContent(),
				)
				.toContain("Open project");
			await quickOpen.fill(">settings");
			await electron.page.keyboard.press("Enter");
			await expect.poll(() => quickOpen.count()).toBe(0);
			await electron.page.keyboard.press("ControlOrMeta+k");
			await quickOpen.fill("no-matching-chat-ship-check");
			await electron.page.keyboard.press("Enter");
			await expect.poll(() => quickOpen.count()).toBe(1);
			await electron.page.keyboard.press("Escape");
			await expect.poll(() => quickOpen.count()).toBe(0);
			await electron.page.keyboard.press("ControlOrMeta+k");
			await quickOpen.fill("Search files");
			await electron.page.keyboard.press("Enter");
			const fileSearch = electron.page.getByRole("combobox", {
				name: "Search files",
				exact: true,
			});
			await fileSearch.waitFor({ state: "visible" });
			await expect.poll(() => quickOpen.count()).toBe(0);
			await fileSearch.fill("README.md");
			await electron.page
				.getByRole("option", { name: "README.md", exact: true })
				.waitFor({ state: "visible" });
			await electron.page.keyboard.press("Escape");
			await electron.page.keyboard.press("ControlOrMeta+p");
			await fileSearch.waitFor({ state: "visible" });
			await electron.page.keyboard.press("Escape");
			const composer = electron.page
				.locator(".cm-content[contenteditable='true']")
				.last();
			await electron.page.keyboard.press("ControlOrMeta+k");
			await quickOpen.fill(">focus composer");
			await electron.page.keyboard.press("Enter");
			await expect
				.poll(() => composer.evaluate((el) => el === document.activeElement))
				.toBe(true);
			await composer.fill("Electron system message");
			await electron.page.getByRole("button", { name: "Send" }).click();
			try {
				await electron.page
					.getByText("Hello from deterministic provider.", { exact: true })
					.first()
					.waitFor({ state: "visible", timeout: 20_000 });
				await expect
					.poll(
						() =>
							electron.page
								.locator(
									'[aria-label="Starting agent"], [aria-label^="Agent is "]',
								)
								.count(),
						{ timeout: 10_000 },
					)
					.toBe(0);
			} catch (cause) {
				const artifact = await electron.captureFailure("electron-chat-send");
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text:\n${await electron.page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}

			await composer.fill("Second Electron system message");
			await electron.page.getByRole("button", { name: "Send" }).click();
			await expect
				.poll(
					() =>
						electron.page
							.getByText("Hello from deterministic provider.", { exact: true })
							.count(),
					{ timeout: 20_000 },
				)
				.toBe(2);
			const overflowPrompts = Array.from(
				{ length: 9 },
				(_, index) => `Electron overflow turn ${index + 3}`,
			);
			for (const prompt of overflowPrompts) {
				await composer.fill(prompt);
				await electron.page.getByRole("button", { name: "Send" }).click();
				const promptBubble = electron.page
					.locator("[data-chat-user-bubble]")
					.filter({ hasText: prompt })
					.last();
				await promptBubble.waitFor({ state: "visible", timeout: 20_000 });
				await promptBubble
					.locator("xpath=following::*[@data-chat-assistant-bubble][1]")
					.getByText("Hello from deterministic provider.", { exact: true })
					.waitFor({ state: "visible", timeout: 20_000 });
			}

			const turnNavigator = electron.page.getByRole("button", {
				name: "Navigate conversation",
			});
			const paneEdges = await electron.page.evaluate(() => {
				const viewport = document.querySelector<HTMLElement>(
					"[data-chat-viewport]",
				);
				const transcript =
					viewport?.querySelector<HTMLElement>('[data-pane="chat"]');
				const navigator = viewport?.querySelector<HTMLElement>(
					"[data-chat-turn-navigator]",
				);
				const composerFade = document.querySelector<HTMLElement>(
					"[data-chat-composer-fade]",
				);
				if (!viewport || !transcript || !navigator || !composerFade) {
					return null;
				}
				return {
					viewportLeft: viewport.getBoundingClientRect().left,
					viewportRight: viewport.getBoundingClientRect().right,
					transcriptRight: transcript.getBoundingClientRect().right,
					navigatorRight: navigator.getBoundingClientRect().right,
					composerFadeLeft: composerFade.getBoundingClientRect().left,
					composerFadeRight: composerFade.getBoundingClientRect().right,
				};
			});
			expect(paneEdges).not.toBeNull();
			if (paneEdges === null)
				throw new Error("Chat pane edges were unavailable");
			expect(
				Math.abs(paneEdges.transcriptRight - paneEdges.viewportRight),
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(paneEdges.navigatorRight - paneEdges.viewportRight),
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(paneEdges.composerFadeLeft - paneEdges.viewportLeft),
			).toBeLessThanOrEqual(1);
			expect(
				Math.abs(paneEdges.composerFadeRight - paneEdges.viewportRight),
			).toBeLessThanOrEqual(1);
			await turnNavigator.hover();
			const turnList = electron.page.getByRole("listbox", {
				name: "Conversation turns",
			});
			await turnList.waitFor({ state: "visible" });
			await turnList.hover();
			await electron.page.mouse.wheel(0, 1_000);
			const lastOverflowPrompt = overflowPrompts.at(-1);
			if (lastOverflowPrompt === undefined) {
				throw new Error("Overflow turn fixture was not created");
			}
			const lastTurn = turnList.getByRole("option", {
				name: lastOverflowPrompt,
				exact: true,
			});
			await lastTurn.waitFor({ state: "visible" });
			expect(await turnList.isVisible()).toBe(true);
			expect(
				await electron.page
					.getByRole("combobox", { name: "Find a turn" })
					.count(),
			).toBe(0);
			expect(await electron.page.getByText("Conversation map").count()).toBe(0);
			await lastTurn.click();
			await turnList.waitFor({ state: "hidden" });
			const timelineStores = await electron.page.evaluate(
				() =>
					new Promise<Array<string>>((resolve, reject) => {
						const request = indexedDB.open("zuse-session-timelines");
						request.onsuccess = () => {
							const database = request.result;
							resolve(Array.from(database.objectStoreNames));
							database.close();
						};
						request.onerror = () => reject(request.error);
					}),
			);
			expect(timelineStores).toContain("reading-positions");
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
					.first()
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

	it("keeps chat creation in the background and reconciles stop state", async () => {
		await withSystemTest("zuse-electron-create-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server();
			const rpc = await scope.rpc(server.endpoint);
			await Effect.runPromise(
				rpc.client["settings.update"]({
					patch: {
						onboardingCompleted: true,
						defaultProviderId: "gemini",
						defaultAutoCreateWorktree: true,
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

			const controller = await scope.controller();
			const provider = installFakeAcpProvider({
				root: scope.root,
				scenario: "hold",
				controlPort: controller.port,
			});
			const electron = await scope.acquire(
				() =>
					launchElectronApp({
						root: scope.root,
						userData: server.userData,
						providerBinDirectory: provider.binDirectory,
						providerEnvironment: provider.environment,
					}),
				(value) => value.close(),
			);
			try {
				const existingTitle = electron.page
					.getByText(conversation.chat.title, { exact: true })
					.first();
				await existingTitle.waitFor({ state: "visible", timeout: 20_000 });
				await electron.page
					.getByRole("button", { name: "New chat" })
					.first()
					.click();
				const composer = electron.page
					.locator(".cm-content[contenteditable='true']")
					.last();
				await composer.fill("Keep this creation in the background");
				await electron.page.getByRole("button", { name: "Send" }).click();
				const optimisticMessage = electron.page.getByText(
					"Keep this creation in the background",
					{ exact: true },
				);
				await optimisticMessage.waitFor({ state: "visible", timeout: 2_000 });
				const lifecycle = electron.page.getByText(/Creating a new copy of .+…/);
				await lifecycle.waitFor({ state: "visible", timeout: 10_000 });
				const [messageBox, lifecycleBox] = await Promise.all([
					optimisticMessage.boundingBox(),
					lifecycle.boundingBox(),
				]);
				expect(messageBox).not.toBeNull();
				expect(lifecycleBox).not.toBeNull();
				if (messageBox === null || lifecycleBox === null) {
					throw new Error(
						"Expected message and lifecycle rows to have layout boxes",
					);
				}
				expect(messageBox.y).toBeLessThan(lifecycleBox.y);

				await existingTitle.click();
				const existingRow = existingTitle.locator(
					"xpath=ancestor::*[@role='button'][1]",
				);
				await electron.page.waitForTimeout(1_000);
				expect(await existingRow.getAttribute("class")).toContain(
					"bg-sidebar-accent",
				);

				await electron.page
					.locator('[data-pane="sidebar"] [role="button"][title="New chat"]')
					.first()
					.click();
				await controller.waitFor("prompt.held", undefined, 20_000);
				const stop = electron.page.getByRole("button", {
					name: "Stop current turn",
				});
				await stop.waitFor({ state: "visible", timeout: 10_000 });
				await stop.click({ timeout: 10_000 });
				await controller.waitFor("prompt.cancelled", undefined, 10_000);
				await stop.waitFor({ state: "hidden", timeout: 10_000 });
				expect(electron.errors).toEqual([]);
			} catch (cause) {
				const artifact = await electron.captureFailure(
					"electron-chat-create-lifecycle",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text:\n${await electron.page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}
		});
	}, 75_000);
});
