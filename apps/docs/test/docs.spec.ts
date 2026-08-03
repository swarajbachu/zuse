import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("guide deep links render", async ({ page }) => {
	await page.goto("/start/first-chat");
	await expect(
		page.getByRole("heading", { name: "Create your first chat" }),
	).toBeVisible();
});

test("full-text search supports the keyboard", async ({ page, isMobile }) => {
	test.skip(isMobile, "Mobile uses the navigation-sheet search trigger");
	await page.goto("/start/first-chat");
	await page.keyboard.press("Control+k");
	const search = page.getByRole("textbox", { name: "Search" });
	await search.fill("status json");
	await expect(
		page.getByRole("button", { name: /Serve status JSON/ }).first(),
	).toBeVisible();
	await page
		.getByRole("button", { name: /Serve status JSON/ })
		.first()
		.click();
	await expect(page).toHaveURL(/\/serve\/status-json/u);
});

test("theme choice persists", async ({ page }) => {
	await page.goto("/remote");
	if (await page.getByRole("button", { name: "Open Sidebar" }).isVisible()) {
		await page.getByRole("button", { name: "Open Sidebar" }).click();
	}
	await page.getByRole("button", { name: "Toggle Theme" }).click();
	const theme = await page.locator("html").getAttribute("class");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("class", theme ?? "light");
});

test("page actions expose Markdown and AI readers", async ({ page }) => {
	await page.goto("/serve/command-reference");
	await expect(
		page.getByRole("button", { name: "Copy Markdown" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await expect(
		page.getByRole("link", { name: /View as Markdown/ }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: /Open in ChatGPT/ }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: /Open in Claude/ }),
	).toBeVisible();
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
	await page.getByRole("button", { name: "Open Sidebar" }).click();
	await expect(page.getByRole("link", { name: "Reference" })).toBeVisible();
	await page.getByRole("button", { name: "Open Sidebar" }).last().click();
	await page.getByRole("button", { name: "Open Search" }).click();
	await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
});
