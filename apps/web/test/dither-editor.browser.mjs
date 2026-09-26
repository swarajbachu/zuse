import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Run against `bun run --cwd apps/web dev`, or set DITHER_TEST_URL to a build.
// Real canvas/worker rendering verifies that recovery never exports stale pixels.
const browser = await chromium.launch({
	headless: true,
	args: ["--disable-dev-shm-usage"],
	...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
		? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
		: {}),
});
try {
	const page = await browser.newPage();
	await page.goto(
		process.env.DITHER_TEST_URL ?? "http://localhost:3001/tools/dither",
	);
	const upload = page.locator('input[type="file"]');
	const exportButton = page.getByRole("button", { name: "Export PNG" });
	const contrast = page.getByRole("slider", { name: "Contrast", exact: true });
	const settled = () =>
		exportButton.waitFor({ state: "visible" }).then(() =>
			page.waitForFunction(() => {
				const button = [...document.querySelectorAll("button")].find((b) =>
					b.textContent.includes("Export PNG"),
				);
				return button && !button.disabled;
			}),
		);
	const invalidUpload = () =>
		upload.setInputFiles({
			name: "bad.png",
			mimeType: "image/png",
			buffer: Buffer.from("invalid image"),
		});
	const adjust = async (value) => {
		await contrast.fill(String(value));
		await settled();
	};
	await upload.setInputFiles(
		resolve(import.meta.dirname, "../public/brand/observatory.webp"),
	);
	await settled();
	await adjust(145);
	const preview = () =>
		page
			.locator("canvas")
			.first()
			.evaluate((canvas) => canvas.toDataURL());
	const before = await preview();
	await invalidUpload();
	await page
		.getByRole("region", { name: "Image preview" })
		.getByRole("alert")
		.waitFor();
	await page
		.getByRole("region", { name: "Image preview" })
		.getByRole("alert")
		.getByRole("button")
		.click();
	await settled();
	assert.equal(
		await contrast.inputValue(),
		"145",
		"Dismissing a failed replacement must preserve adjustments",
	);
	assert.equal(
		await preview(),
		before,
		"Failed replacement must preserve rendered pixels",
	);

	// Export failure must also preserve adjustments and permit a retry.
	await page.evaluate(() => {
		const original = HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toBlob = (callback) => {
			HTMLCanvasElement.prototype.toBlob = original;
			callback(null);
		};
	});
	await exportButton.click();
	await page
		.getByRole("region", { name: "Image preview" })
		.getByRole("alert")
		.waitFor();
	await page
		.getByRole("button", { name: "Dismiss error", exact: true })
		.click();
	await settled();
	assert.equal(await contrast.inputValue(), "145");
	const download = page.waitForEvent("download");
	await exportButton.click();
	assert.match((await download).suggestedFilename(), /-dither\.png$/);

	// A render failure still offers reset/retry, and cannot export old pixels.
	await page.evaluate(() => {
		window.originalWorker = window.Worker;
		window.Worker = class {
			constructor() {
				throw new Error("Simulated render failure");
			}
		};
	});
	await contrast.fill("155");
	await page
		.getByRole("region", { name: "Image preview" })
		.getByRole("alert")
		.waitFor();
	assert.equal(await exportButton.isDisabled(), true);
	await page.evaluate(() => {
		window.Worker = window.originalWorker;
	});
	await page
		.getByRole("button", { name: "Reset adjustments and dismiss error" })
		.click();
	await settled();
	assert.equal(await contrast.inputValue(), "100");

	// A subsequent rejected upload cannot make a failed render exportable.
	await page.evaluate(() => {
		window.Worker = class {
			constructor() {
				throw new Error("Simulated render failure");
			}
		};
	});
	await contrast.fill("155");
	await page
		.getByRole("region", { name: "Image preview" })
		.getByRole("alert")
		.waitFor();
	await invalidUpload();
	await page
		.getByRole("button", { name: "Dismiss error", exact: true })
		.waitFor();
	await page
		.getByRole("button", { name: "Dismiss error", exact: true })
		.click();
	assert.equal(await contrast.inputValue(), "155");
	assert.equal(await exportButton.isDisabled(), true);
	assert.match(
		await page.getByRole("status").textContent(),
		/Render failed.*reset adjustments to retry/i,
	);
	await page.evaluate(() => {
		window.Worker = window.originalWorker;
	});
	await page
		.getByRole("button", { name: "Reset adjustments", exact: true })
		.click();
	await settled();
	assert.equal((await page.getByRole("status").textContent()).trim(), "Ready");
	console.log(
		"Dither editor recovery passed: upload, export retry, render reset, stale export protection.",
	);
} finally {
	await browser.close();
}
