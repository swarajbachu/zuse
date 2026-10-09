import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { HtmlPreviewInput, HtmlPreviewResult } from "@zuse/contracts";
import {
	defaultHtmlTheme,
	prepareHtmlDocument,
} from "@zuse/utils/html-document";
import type { Browser, BrowserContext, BrowserType } from "playwright";
import { PreviewQueue } from "./preview-queue.ts";
import { startPublicProxy } from "./public-proxy.ts";

export const htmlPreviewInstaller = () =>
	join(
		dirname(createRequire(import.meta.url).resolve("playwright/package.json")),
		"cli.js",
	).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");

/** An executable can exist midway through extraction; require Playwright's completion marker. */
export function isChromiumInstalled(executable: string): boolean {
	if (!existsSync(executable)) return false;
	for (
		let directory = dirname(executable);
		dirname(directory) !== directory;
		directory = dirname(directory)
	) {
		if (/^chromium-\d+$/.test(basename(directory)))
			return existsSync(join(directory, "INSTALLATION_COMPLETE"));
	}
	return false;
}

/** One browser per server; no app profile, cookies, visible tabs, or renderer dependency. */
export class HtmlPreviewBrowser {
	constructor(
		private readonly options: {
			executablePath?: string;
			timeoutMs?: number;
		} = {},
	) {}
	private readonly queue = new PreviewQueue();
	private readonly shutdown = new AbortController();
	private browser: Promise<Browser> | undefined;
	private proxy: Awaited<ReturnType<typeof startPublicProxy>> | undefined;
	private installing: Promise<void> | undefined;
	private installError: Error | undefined;

	private async provision(chromium: BrowserType<Browser>): Promise<void> {
		if (this.installError) {
			const error = this.installError;
			this.installError = undefined;
			throw error;
		}
		if (
			!this.installing &&
			(this.options.executablePath ||
				isChromiumInstalled(chromium.executablePath()))
		)
			return;
		if (!this.installing) {
			const cli = htmlPreviewInstaller();
			this.installing = new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[cli, "install", "chromium", "--no-shell"],
					{
						stdio: "ignore",
						env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
						signal: this.shutdown.signal,
						timeout: 180_000,
					},
				);
				child.once("error", reject);
				child.once("exit", (code) =>
					code === 0
						? resolve()
						: reject(new Error("Could not install the HTML preview browser")),
				);
			})
				.catch((cause: unknown) => {
					this.installError =
						cause instanceof Error ? cause : new Error(String(cause));
					throw cause;
				})
				.finally(() => {
					this.installing = undefined;
				});
			// Installation outlives an individual request, but is stopped with the server.
			void this.installing.catch(() => {});
		}
		throw new Error(
			"The HTML preview browser is installing. Retry shortly; html_render is available now.",
		);
	}

	private getBrowser(): Promise<Browser> {
		this.browser ??= (async () => {
			const { chromium } = await import("playwright");
			await this.provision(chromium);
			this.shutdown.signal.throwIfAborted();
			this.proxy ??= await startPublicProxy();
			const browser = await chromium.launch({
				headless: true,
				executablePath:
					this.options.executablePath ?? chromium.executablePath(),
				timeout: 20_000,
				proxy: { server: `socks5://127.0.0.1:${this.proxy.port}` },
				args: [
					"--proxy-bypass-list=<-loopback>",
					"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
					"--disable-quic",
					"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
				],
			});
			browser.on("disconnected", () => {
				this.browser = undefined;
			});
			return browser;
		})().catch((error: unknown) => {
			this.browser = undefined;
			throw error;
		});
		return this.browser;
	}

	async preview(
		input: HtmlPreviewInput,
		signal: AbortSignal,
	): Promise<HtmlPreviewResult> {
		const combined = AbortSignal.any([
			signal,
			this.shutdown.signal,
			AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
		]);
		return this.queue.run(async (jobSignal) => {
			let context: BrowserContext | undefined;
			const abort = () => {
				void context?.close().catch(() => {});
			};
			jobSignal.addEventListener("abort", abort, { once: true });
			try {
				const browser = await this.getBrowser();
				jobSignal.throwIfAborted();
				const width = input.width ?? 728;
				context = await browser.newContext({
					viewport: { width, height: 80 },
					colorScheme: input.appearance ?? "dark",
					serviceWorkers: "block",
					acceptDownloads: false,
				});
				jobSignal.throwIfAborted();
				// The SOCKS proxy pins validated DNS addresses; routing alone cannot
				// protect against rebinding or browser speculative connections.
				await context.route("**/*", (route) =>
					/^https?:/.test(route.request().url()) &&
					!route.request().isNavigationRequest()
						? route.continue()
						: route.abort(),
				);
				const page = await context.newPage();
				page.setDefaultTimeout(10_000);
				const consoleMessages: Array<{ level: string; text: string }> = [];
				const log = (level: string, text: string) => {
					if (consoleMessages.length < 100)
						consoleMessages.push({ level, text: text.slice(0, 2000) });
				};
				page.on("console", (message) => log(message.type(), message.text()));
				page.on("pageerror", (error) => log("error", error.message));
				const doc = prepareHtmlDocument(
					input.html,
					defaultHtmlTheme(input.appearance ?? "dark"),
				);
				// Preview the same opaque-origin sandbox as the chat viewer.
				const src = `data:text/html;base64,${Buffer.from(doc).toString("base64")}`;
				await page.setContent(
					`<style>body{margin:0;background:${input.appearance === "light" ? "#fff" : "#101010"}}</style><iframe title="Visual" sandbox="allow-scripts" style="border:0;width:100%;height:80px" src="${src}"></iframe>`,
					{ waitUntil: "load", timeout: 15_000 },
				);
				const visual = page
					.frames()
					.find((frame) => frame.parentFrame() === page.mainFrame());
				if (!visual) throw new Error("Preview frame did not load");
				const contentHeight = await visual.evaluate<number>(
					`(async () => { await document.fonts.ready; return Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height)); })()`,
				);
				const capturedHeight = Math.max(80, Math.min(2000, contentHeight));
				await page.setViewportSize({ width, height: capturedHeight });
				await page
					.locator("iframe")
					.evaluate(
						`(frame) => { frame.style.height = "${capturedHeight}px"; }`,
					);
				const screenshot = await page.screenshot({
					type: "png",
					animations: "disabled",
					timeout: 5000,
				});
				jobSignal.throwIfAborted();
				if (screenshot.byteLength > 4 * 1024 * 1024)
					throw new Error(
						"Preview screenshot exceeds 4 MB; use a smaller viewport or simpler visual",
					);
				return {
					width,
					contentHeight,
					capturedHeight,
					consoleMessages,
					screenshot: {
						mimeType: "image/png",
						data: screenshot.toString("base64"),
					},
				};
			} finally {
				jobSignal.removeEventListener("abort", abort);
				await context?.close().catch(() => {});
			}
		}, combined);
	}

	async close(): Promise<void> {
		this.shutdown.abort();
		await (await this.browser?.catch(() => undefined))?.close();
		await this.proxy?.close();
	}
}
