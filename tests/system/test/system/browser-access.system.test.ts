import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { withSystemTest } from "../../src/system-scope.ts";

describe("browser access", () => {
	it("pairs without leaking the credential and restores the session on reload", async () => {
		await withSystemTest("zuse-browser-access-", async (scope) => {
			const server = await scope.server({ authPolicy: "protected" });
			const pairingLine = await server.process.waitForStdout(
				(line) => line.startsWith("Browser: "),
				"browser pairing URL",
				10_000,
			);
			const pairingUrl = pairingLine.slice("Browser: ".length);
			const browser = await chromium.launch({
				channel: process.env.ZUSE_SYSTEM_CHROME_CHANNEL ?? "chrome",
				headless: true,
			});
			try {
				const page = await browser.newPage();
				await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
				await expect
					.poll(() => page.url(), { timeout: 15_000 })
					.not.toContain("#pair=");
				await expect
					.poll(
						() =>
							page.evaluate(async () => {
								const response = await fetch("/auth/session");
								return response.json() as Promise<{
									authenticated: boolean;
								}>;
							}),
						{ timeout: 15_000 },
					)
					.toMatchObject({ authenticated: true });
				await page.reload({ waitUntil: "domcontentloaded" });
				await expect
					.poll(() => page.locator("#root").textContent(), { timeout: 15_000 })
					.not.toContain("Pair this browser");
			} finally {
				await browser.close();
				await server.stop();
			}
		});
	}, 45_000);
});
