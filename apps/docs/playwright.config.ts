import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./test",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: "http://127.0.0.1:3002",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{
			name: "mobile",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],
	webServer: {
		command: "bun run build && bun run preview --hostname 127.0.0.1",
		url: "http://127.0.0.1:3002",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
