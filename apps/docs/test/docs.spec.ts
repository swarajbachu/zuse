import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("home and guide deep links render", async ({ page }) => {
	await page.goto("/");
	await expect(
		page.getByRole("heading", {
			name: "Build locally. Stay in control everywhere.",
		}),
	).toBeVisible();
	await page.goto("/start/first-chat");
	await expect(
		page.getByRole("heading", { name: "Create your first chat" }),
	).toBeVisible();
});

test("full-text search supports the keyboard", async ({ page, isMobile }) => {
	test.skip(isMobile, "Mobile uses the navigation-sheet search trigger");
	await page.goto("/start/first-chat");
	await page.keyboard.press("Control+k");
	const search = page.getByRole("textbox", { name: "Search documentation" });
	await search.fill("status json");
	await expect(
		page.getByRole("link", { name: /Serve status JSON/ }).first(),
	).toBeVisible();
	await page
		.getByRole("link", { name: /Serve status JSON/ })
		.first()
		.click();
	await expect(page).toHaveURL(/\/serve\/status-json/u);
});

test("theme choice persists", async ({ page }) => {
	await page.goto("/remote");
	await page.getByRole("button", { name: "Change color theme" }).click();
	const theme = await page.locator("html").getAttribute("data-theme");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute(
		"data-theme",
		theme ?? "light",
	);
});

test("Markdown responses and missing routes are explicit", async ({
	request,
}) => {
	const markdown = await request.get("/serve/command-reference.md");
	expect(markdown.ok()).toBeTruthy();
	expect(markdown.headers()["content-type"]).toContain("text/markdown");
	expect(await markdown.text()).toContain("zuse serve status [--json]");
	const missing = await request.get("/not-a-public-route");
	expect(missing.status()).toBe(404);
});

test("representative article has no automatic accessibility violations", async ({
	page,
}) => {
	await page.goto("/serve/command-reference");
	const results = await new AxeBuilder({ page: page as never }).analyze();
	expect(results.violations).toEqual([]);
});

test("mobile navigation contains search", async ({ page, isMobile }) => {
	test.skip(!isMobile, "Mobile-only navigation behavior");
	await page.goto("/remote");
	await page
		.getByRole("button", { name: "Open documentation navigation" })
		.click();
	await expect(
		page.getByRole("navigation", { name: "Mobile documentation navigation" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Search documentation" })
		.last()
		.click();
	await expect(
		page.getByRole("textbox", { name: "Search documentation" }),
	).toBeVisible();
});
