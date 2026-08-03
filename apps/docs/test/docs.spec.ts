import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("how-to guide deep links render", async ({ page }) => {
	await page.goto("/how-to/local-parallel-worktrees");
	await expect(
		page.getByRole("heading", { name: "Run tasks in parallel with worktrees" }),
	).toBeVisible();
});

test("browser and orchestration guides render as linked documentation", async ({
	page,
}) => {
	await page.goto("/workspace/browser");
	await expect(
		page.getByRole("heading", { name: "In-app browser" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Browser debugging" }).first().click();
	await expect(page).toHaveURL(/\/workspace\/browser-debugging/u);

	await page.goto("/composer/orchestration");
	await expect(
		page.getByRole("heading", { name: "Agent orchestration" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Run agents in parallel" }).first(),
	).toBeVisible();
});

test("product links use the canonical website domain", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "Desktop sidebar links");
	await page.goto("/start/install");

	const sidebar = page.locator("#nd-sidebar");
	await expect(sidebar.getByRole("link", { name: "Product" })).toHaveAttribute(
		"href",
		"https://zuse.sh",
	);
	await expect(sidebar.getByRole("link", { name: "Download" })).toHaveAttribute(
		"href",
		"https://zuse.sh/download",
	);
});

test("reference and how-to guides use separate navigation modes", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "Desktop sidebar mode selector");
	await page.goto("/start/first-chat");

	const sidebar = page.locator("#nd-sidebar");
	const modeSelector = sidebar.locator('button[aria-haspopup="dialog"]');
	await expect(modeSelector).toContainText("Reference");
	await expect(sidebar.getByText("Start here", { exact: true })).toBeVisible();
	await expect(sidebar.getByText("How to", { exact: true })).toHaveCount(0);

	await modeSelector.click();
	await page.getByRole("link", { name: /How to/ }).click();
	await expect(page).toHaveURL(/\/how-to$/u);
	await expect(modeSelector).toContainText("How to");
	await expect(
		sidebar.getByText("Run tasks in parallel with worktrees", { exact: true }),
	).toBeVisible();
	await expect(sidebar.getByText("Start here", { exact: true })).toHaveCount(0);
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

test("navigation uses disclosure headings and native active states", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "Desktop sidebar state");
	await page.goto("/concepts/local-first");

	const sidebar = page.locator("#nd-sidebar");
	await expect(
		sidebar.getByRole("button", { name: "Core concepts" }),
	).toBeVisible();
	await expect(
		sidebar.getByRole("link", { name: "Core concepts" }),
	).toHaveCount(0);
	await expect(sidebar.getByRole("link", { name: "Overview" })).toBeVisible();

	const activeLink = page.locator("#nd-sidebar a[data-active='true']");
	const activeBackground = await activeLink.evaluate(
		(element) => getComputedStyle(element).backgroundColor,
	);
	expect(activeBackground).not.toBe("rgba(0, 0, 0, 0)");
	const activeIndicator = await activeLink.evaluate((element) => {
		const style = getComputedStyle(element, "::before");
		return {
			height: style.getPropertyValue("height"),
			inlineStart: style.getPropertyValue("inset-inline-start"),
			width: style.getPropertyValue("width"),
		};
	});
	expect(activeIndicator).toEqual({
		height: "12px",
		inlineStart: "0px",
		width: "2px",
	});
	const folderGuide = sidebar.locator(
		'div[data-state="open"][class*="before:inset-y-1"]:has(a[data-active="true"])',
	);
	const folderGuideContent = await folderGuide.evaluate((element) =>
		getComputedStyle(element, "::before").getPropertyValue("content"),
	);
	expect(folderGuideContent).toBe("none");

	await page.keyboard.press("Control+k");
	await page.getByRole("textbox", { name: "Search" }).fill("worktree");
	const selectedResult = page.locator(
		"[role='dialog'] button[aria-selected='true']",
	);
	await expect(selectedResult).toBeVisible();
	await expect(selectedResult).toHaveCSS("box-shadow", "none");
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

test("LLM requests receive Markdown without changing the page URL", async ({
	request,
}) => {
	const negotiated = await request.get("/remote", {
		headers: { Accept: "text/markdown" },
	});
	expect(negotiated.ok()).toBeTruthy();
	expect(negotiated.headers()["content-type"]).toContain("text/markdown");
	expect(negotiated.headers().vary).toContain("Accept");
	expect(await negotiated.text()).toContain("# Remote access");

	const root = await request.get("/", {
		headers: { Accept: "text/markdown" },
	});
	expect(root.ok()).toBeTruthy();
	expect(root.headers()["content-type"]).toContain("text/markdown");
	expect(await root.text()).toContain("# Start here");

	const crawler = await request.get("/serve", {
		headers: { "User-Agent": "GPTBot/1.0" },
	});
	expect(crawler.headers()["content-type"]).toContain("text/markdown");
	expect(await crawler.text()).toContain("# Zuse Serve");

	const index = await request.get("/llms.txt");
	expect(index.ok()).toBeTruthy();
	expect(index.headers()["content-type"]).toContain("text/markdown");
	const indexText = await index.text();
	expect(indexText).toContain("Serve command reference");
	expect(indexText).toContain(
		"https://docs.zuse.sh/serve/command-reference.md",
	);

	const indexedPage = await request.get("/serve/command-reference.md");
	expect(indexedPage.headers()["content-type"]).toContain("text/markdown");

	const fullIndex = await request.get("/llms-full.txt");
	expect(fullIndex.ok()).toBeTruthy();
	expect(await fullIndex.text()).toContain("# Configure MCP servers locally");

	const browser = await request.get("/remote", {
		headers: { Accept: "text/html" },
	});
	expect(browser.headers()["content-type"]).toContain("text/html");
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
	await expect(
		page.locator("button:has(> svg.lucide-chevrons-up-down)"),
	).toContainText("Reference");
	await page.getByRole("button", { name: "Open Sidebar" }).last().click();
	await page.getByRole("button", { name: "Open Search" }).click();
	await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
});
