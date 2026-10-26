import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".project-plan-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15833,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "project-plan-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__plan", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__plan.html",
							'<html><body><div id="root"></div><script type="module" src="/@id/__x00__project-plan-probe"></script></body></html>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0project-plan-probe") return id;
				if (
					importer?.includes("project-plan-tray.tsx") &&
					id.endsWith("session-timeline-hooks.ts")
				)
					return "\0project-plan-timeline";
			},
			load(id) {
				if (id === "\0project-plan-timeline")
					return `
export const useRendererSessionTimeline = () => ({ messages: [{
 content: { _tag: 'tool_use', itemId: 'plan', tool: 'TodoWrite', input: { todos: [
  { content: 'Inspect task updates', status: 'completed' },
  { content: 'Verify expansion', status: 'pending' }
 ] } }
}] });`;
				if (id === "\0project-plan-probe")
					return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectPlanTray } from '/src/components/composer/project-plan-tray.tsx';
createRoot(document.getElementById('root')).render(React.createElement(ProjectPlanTray, {sessionId: 'session', environmentId: 'local'}));`;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_BIN,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__plan`,
	);
	// Select the chevron specifically: the first button is the clickable title.
	const chevron = page.getByRole("button").nth(1);
	const title = page.getByRole("button").nth(0);
	const list = page.getByRole("list");
	await expect(chevron).toHaveAttribute("aria-expanded", "false");
	await expect(list).toHaveCount(0);
	await chevron.click();
	await expect(chevron).toHaveAttribute("aria-expanded", "true");
	await expect(title).toHaveAttribute("aria-expanded", "true");
	await expect(list).toBeVisible();
	await expect(list.getByRole("listitem")).toHaveText([
		"Inspect task updates",
		"Verify expansion",
	]);
	await chevron.click();
	await expect(chevron).toHaveAttribute("aria-expanded", "false");
	await expect(title).toHaveAttribute("aria-expanded", "false");
	await expect(list).toHaveCount(0);
	assert.deepEqual(errors, []);
	console.log("Project plan chevron expands and collapses the task list.");
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
