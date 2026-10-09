import { randomUUID } from "node:crypto";
import { startPublicProxy } from "@zuse/utils/public-network-proxy";
import { type Session, session, type WebContents } from "electron";

export const VISUAL_ASSET_SCHEMES = [
	"zuse-visual-http",
	"zuse-visual-https",
] as const;
const isVisualFrame = (url: string) => url.startsWith("data:text/html;base64,");

/** Forward opaque visual frames through a credential-free, public-only network session. */
export function installHtmlVisualNetwork(target: Session) {
	let network: Promise<Session> | undefined;
	let proxy: Awaited<ReturnType<typeof startPublicProxy>> | undefined;
	let closed = false;
	const controller = new AbortController();
	const getNetwork = () => {
		network ??= (async () => {
			proxy = await startPublicProxy();
			if (closed) {
				await proxy.close();
				throw new Error("Visual networking closed");
			}
			const isolated = session.fromPartition(`zuse-visual-${randomUUID()}`, {
				cache: false,
			});
			isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
				callback(false),
			);
			isolated.setPermissionCheckHandler(() => false);
			await isolated.setProxy({
				mode: "fixed_servers",
				proxyRules: `socks5://127.0.0.1:${proxy.port}`,
				proxyBypassRules: "<-loopback>",
			});
			return isolated;
		})().catch(async (error) => {
			await proxy?.close();
			proxy = undefined;
			network = undefined;
			throw error;
		});
		return network;
	};
	for (const scheme of VISUAL_ASSET_SCHEMES) {
		target.protocol.handle(scheme, async (request) => {
			try {
				// Never forward app cookies, authorization, or arbitrary request headers.
				// Static assets and public GET APIs cover visualization dependencies.
				if (request.method !== "GET")
					return new Response(null, { status: 405 });
				const url = new URL(
					request.url.replace(
						`${scheme}:`,
						scheme === "zuse-visual-http" ? "http:" : "https:",
					),
				);
				if (url.username || url.password)
					return new Response(null, { status: 403 });
				const transport = await getNetwork();
				const response = await transport.fetch(url.href, {
					credentials: "omit",
					signal: AbortSignal.any([
						controller.signal,
						request.signal,
						AbortSignal.timeout(30_000),
					]),
				});
				// Do not propagate Set-Cookie, redirects, or upstream policy headers to the app session.
				const headers = new Headers({
					"Access-Control-Allow-Origin": "*",
					"Cache-Control": "no-store",
				});
				const type = response.headers.get("content-type");
				if (type) headers.set("content-type", type);
				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch {
				return new Response(null, { status: 502 });
			}
		});
	}
	// This is the application's only onBeforeRequest handler. Browser tabs have a separate session.
	target.webRequest.onBeforeRequest((details, callback) => {
		if (!isVisualFrame(details.frame?.url ?? "")) return callback({});
		if (details.resourceType === "subFrame") return callback({ cancel: true });
		if (/^https?:/.test(details.url))
			return callback({
				redirectURL: details.url.replace(/^http/, "zuse-visual-http"),
			});
		if (/^(data:|blob:|zuse-visual-https?:)/.test(details.url))
			return callback({});
		callback({ cancel: true });
	});
	return async () => {
		closed = true;
		controller.abort();
		await network?.catch(() => {});
		await proxy?.close();
	};
}

/** A visual cannot navigate away from the document whose requests we isolate. */
export function guardHtmlVisualNavigation(contents: WebContents) {
	contents.on("will-frame-navigate", (event) => {
		if (isVisualFrame(event.frame?.url ?? "")) event.preventDefault();
	});
}
