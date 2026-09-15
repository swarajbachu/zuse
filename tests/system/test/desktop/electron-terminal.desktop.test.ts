import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'\\''`)}'`;

const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";

const onePixelPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

const seedInternalImageFixtures = (userData: string): void => {
	const attachments = join(userData, "attachments");
	const pokemon = join(userData, "pokemon-sprites");
	mkdirSync(attachments, { recursive: true });
	mkdirSync(pokemon, { recursive: true });
	writeFileSync(join(attachments, "e2e-attachment.png"), onePixelPng);
	writeFileSync(join(pokemon, "25.png"), onePixelPng);
};

describe("built Electron terminal", () => {
	it("preserves input order, survives output load, and restarts cleanly after a replay gap", async () => {
		await withSystemTest("zuse-electron-terminal-", async (scope) => {
			const repository = scope.path("repository");
			initializeSystemRepository(repository);
			const server = await scope.server();
			seedInternalImageFixtures(server.userData);
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
			const conversationLink = page
				.getByText(conversation.chat.title, { exact: true })
				.first();
			try {
				await conversationLink.waitFor({ state: "visible", timeout: 20_000 });
			} catch (cause) {
				await page.reload({ waitUntil: "domcontentloaded" });
				await page.waitForTimeout(2_000);
				const artifact = await electron.captureFailure(
					"electron-terminal-startup",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text:\n${await page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}
			expect(
				await page.evaluate(
					() => new URL("./assets/probe.js", document.baseURI).href,
				),
			).toBe("zuse://renderer/assets/probe.js");
			const internalImages = await page.evaluate(async () => {
				const load = (src: string) =>
					new Promise<{
						readonly src: string;
						readonly width: number;
						readonly height: number;
					}>((resolve, reject) => {
						const image = new Image();
						const timer = window.setTimeout(
							() => reject(new Error(`Timed out loading ${src}`)),
							5_000,
						);
						image.onload = () => {
							window.clearTimeout(timer);
							resolve({
								src,
								width: image.naturalWidth,
								height: image.naturalHeight,
							});
						};
						image.onerror = () => {
							window.clearTimeout(timer);
							reject(new Error(`Failed to load ${src}`));
						};
						image.src = src;
					});
				return Promise.all([
					load("zuse://attachments/e2e-attachment"),
					load("zuse://pokemon/25"),
				]);
			});
			expect(internalImages).toEqual([
				{ src: "zuse://attachments/e2e-attachment", width: 1, height: 1 },
				{ src: "zuse://pokemon/25", width: 1, height: 1 },
			]);
			await conversationLink.click();
			await page.keyboard.press(`${primaryModifier}+j`);

			let terminal = page.locator("[data-terminal-instance-id]").last();
			try {
				await terminal.waitFor({ state: "visible", timeout: 20_000 });
			} catch (cause) {
				const artifact = await electron.captureFailure(
					"electron-terminal-right-open",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\npage text:\n${await page.locator("body").innerText()}\n${electron.diagnostics()}`,
				);
			}
			const logicalTerminalId = await terminal.getAttribute(
				"data-terminal-instance-id",
			);
			if (!logicalTerminalId) {
				throw new Error("Terminal did not expose its logical instance id");
			}
			terminal = page.locator(
				`[data-terminal-instance-id="${logicalTerminalId}"]`,
			);
			try {
				await expect
					.poll(() => terminal.getAttribute("data-terminal-status"), {
						timeout: 20_000,
					})
					.toBe("running");
			} catch (cause) {
				const artifact = await electron.captureFailure(
					"electron-terminal-right-running",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\nartifact: ${artifact}\n${electron.diagnostics()}`,
				);
			}
			const input = terminal.getByRole("textbox", { name: "Terminal input" });
			await input.focus();

			const orderedMarker = join(scope.root, "ordered-input-ok");
			const token = "terminalreliability0123456789backspacecheck";
			await page.keyboard.type(token);
			for (let index = 0; index < token.length; index += 1) {
				await page.keyboard.press("Backspace");
			}
			await page.keyboard.type(`/usr/bin/touch ${shellQuote(orderedMarker)}`);
			await page.keyboard.press("Enter");
			await waitForFile(orderedMarker, 10_000);

			// The bottom dock owns a separate catalog and PTY collection. Hiding it
			// must preserve the exact process, while closing one of multiple bottom
			// tabs must terminate only that tab.
			const openBottom = page.getByRole("button", {
				name: "Open bottom terminal",
			});
			await expect.poll(() => openBottom.isEnabled()).toBe(true);
			await openBottom.click();
			let bottomDock = page.getByRole("region", { name: "Bottom terminal" });
			await bottomDock.waitFor({ state: "visible" });
			let bottomTerminal = bottomDock
				.locator("[data-terminal-instance-id]")
				.last();
			await expect
				.poll(() => bottomTerminal.getAttribute("data-terminal-status"), {
					timeout: 20_000,
				})
				.toBe("running");
			const firstBottomId = await bottomTerminal.getAttribute(
				"data-terminal-instance-id",
			);
			expect(firstBottomId).not.toBe(logicalTerminalId);
			const bottomMarker = join(scope.root, "bottom-input-ok");
			await bottomTerminal
				.getByRole("textbox", { name: "Terminal input" })
				.focus();
			await page.keyboard.type(`/usr/bin/touch ${shellQuote(bottomMarker)}`);
			await page.keyboard.press("Enter");
			await waitForFile(bottomMarker, 10_000);

			await bottomDock
				.getByRole("button", { name: "Hide bottom terminal" })
				.click();
			await expect.poll(() => openBottom.isVisible()).toBe(true);
			await openBottom.click();
			bottomDock = page.getByRole("region", { name: "Bottom terminal" });
			bottomTerminal = bottomDock.locator("[data-terminal-instance-id]").last();
			await expect
				.poll(() => bottomTerminal.getAttribute("data-terminal-status"), {
					timeout: 20_000,
				})
				.toBe("running");
			expect(
				await bottomTerminal.getAttribute("data-terminal-instance-id"),
			).toBe(firstBottomId);

			const newBottom = bottomDock.getByRole("button", {
				name: "New bottom terminal",
			});
			await expect.poll(() => newBottom.isEnabled()).toBe(true);
			await newBottom.click();
			await expect
				.poll(() => bottomDock.locator("[data-terminal-instance-id]").count())
				.toBe(2);
			const secondBottom = bottomDock
				.locator("[data-terminal-instance-id]")
				.last();
			await expect
				.poll(() => secondBottom.getAttribute("data-terminal-status"), {
					timeout: 20_000,
				})
				.toBe("running");
			expect(
				await secondBottom.getAttribute("data-terminal-instance-id"),
			).not.toBe(firstBottomId);
			await bottomDock
				.getByRole("button", { name: /^Close / })
				.last()
				.click();
			await expect
				.poll(() => bottomDock.locator("[data-terminal-instance-id]").count())
				.toBe(1);
			expect(
				await bottomDock
					.locator("[data-terminal-instance-id]")
					.first()
					.getAttribute("data-terminal-instance-id"),
			).toBe(firstBottomId);

			await input.focus();
			const floodMarker = join(scope.root, "flood-finished");
			await page.keyboard.type(
				`i=0; while [ $i -lt 20000 ]; do printf 'terminal-line-%s\\n' "$i"; i=$((i+1)); done; /usr/bin/touch ${shellQuote(floodMarker)}`,
			);
			await page.keyboard.press("Enter");
			await waitForFile(floodMarker, 20_000);
			await expect
				.poll(() => terminal.getAttribute("data-terminal-status"), {
					timeout: 10_000,
				})
				.toBe("running");

			const gapStarted = join(scope.root, "gap-started");
			const gapRelease = join(scope.root, "gap-release");
			const gapFinished = join(scope.root, "gap-finished");
			const gapInput = terminal.getByRole("textbox", {
				name: "Terminal input",
			});
			await gapInput.focus();
			const gapCommand = `/usr/bin/touch ${shellQuote(gapStarted)}; while [ ! -f ${shellQuote(gapRelease)} ]; do sleep 0.05; done; i=0; while [ $i -lt 200000 ]; do printf '012345678901234567890123456789%s\\n' "$i"; i=$((i+1)); done; /usr/bin/touch ${shellQuote(gapFinished)}`;
			const pasteHandled = await gapInput.evaluate((element, command) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData("text/plain", command);
				const event = new ClipboardEvent("paste", {
					bubbles: true,
					cancelable: true,
					clipboardData,
				});
				element.dispatchEvent(event);
				return event.defaultPrevented;
			}, gapCommand);
			expect(pasteHandled).toBe(true);
			await page.keyboard.press("Enter");
			try {
				await waitForFile(gapStarted, 10_000);
			} catch (cause) {
				let arrivedAfterClientTimeout = false;
				try {
					await waitForFile(gapStarted, 20_000);
					arrivedAfterClientTimeout = true;
				} catch {
					// The original timeout remains the assertion failure. This longer
					// observation distinguishes a delayed RPC receipt from a rejected write.
				}
				const artifact = await electron.captureFailure(
					"electron-terminal-gap-command",
				);
				throw new Error(
					`${cause instanceof Error ? cause.message : String(cause)}\narrived after client timeout: ${arrivedAfterClientTimeout}\nartifact: ${artifact}\n${electron.diagnostics()}`,
				);
			}
			await page.evaluate(() => window.dispatchEvent(new Event("offline")));
			await expect
				.poll(() => terminal.getAttribute("data-terminal-status"), {
					timeout: 5_000,
				})
				.toBe("reconnecting");
			expect(existsSync(gapFinished)).toBe(false);
			writeFileSync(gapRelease, "release\n");
			await waitForFile(gapFinished, 20_000);
			await page.evaluate(() => window.dispatchEvent(new Event("online")));
			await expect
				.poll(() => terminal.getAttribute("data-terminal-status"), {
					timeout: 20_000,
				})
				.toBe("failed");
			await page
				.getByRole("status", {
					name: /Terminal disconnected — restart it/,
				})
				.waitFor({ state: "visible" });

			await page
				.getByRole("button", { name: "Restart terminal process" })
				.last()
				.click();
			await expect
				.poll(() => terminal.getAttribute("data-terminal-status"), {
					timeout: 20_000,
				})
				.toBe("running");
			expect(await terminal.getAttribute("data-terminal-instance-id")).toBe(
				logicalTerminalId,
			);
			await expect
				.poll(() => terminal.locator("pre[aria-live]").textContent())
				.not.toContain("terminal-line-");
			const replacementMarker = join(scope.root, "replacement-ok");
			await terminal.getByRole("textbox", { name: "Terminal input" }).focus();
			await page.keyboard.type(
				`/usr/bin/touch ${shellQuote(replacementMarker)}`,
			);
			await page.keyboard.press("Enter");
			await waitForFile(replacementMarker, 10_000);
			await expect
				.poll(() =>
					bottomDock
						.locator("[data-terminal-instance-id]")
						.first()
						.getAttribute("data-terminal-status"),
				)
				.toBe("running");
			expect(electron.errors).toEqual([]);
		});
	}, 90_000);
});
