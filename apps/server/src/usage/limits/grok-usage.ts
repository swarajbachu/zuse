import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderUsageLimits } from "@zuse/contracts";

import { unavailable } from "./shared.ts";

type AuthEntry = { key?: string; expires_at?: number; auth_mode?: string };

type GrokBillingResult = {
	billingCycle?: { billingPeriodEnd?: string };
	monthlyLimit?: { val?: number };
	usage?: { totalUsed?: { val?: number } };
};

export const mapGrokBillingResult = (
	result: GrokBillingResult,
): { usedPercent: number | null; resetsAt: string | null } => {
	const limit = result.monthlyLimit?.val;
	const used = result.usage?.totalUsed?.val;
	return {
		usedPercent:
			typeof limit === "number" &&
			limit > 0 &&
			typeof used === "number" &&
			Number.isFinite(used)
				? Math.min(100, Math.max(0, (used / limit) * 100))
				: null,
		resetsAt: result.billingCycle?.billingPeriodEnd ?? null,
	};
};

const fetchGrokCliBilling = async (): Promise<GrokBillingResult | null> => {
	const child = spawn("grok", ["agent", "stdio"], {
		env: process.env,
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lines = createInterface({ input: child.stdout });
	let nextId = 0;
	const request = (method: string, params: unknown, timeoutMs: number) =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			const onLine = (line: string) => {
				try {
					const message = JSON.parse(line) as {
						id?: number;
						result?: unknown;
						error?: { message?: string };
					};
					if (message.id !== id) return;
					cleanup();
					if (message.error) reject(new Error(message.error.message ?? method));
					else resolve(message.result);
				} catch {
					// The CLI may write non-protocol diagnostics to stdout. Ignore them.
				}
			};
			const onExit = () => {
				cleanup();
				reject(new Error("billing process exited"));
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				clearTimeout(timer);
				lines.off("line", onLine);
				child.off("exit", onExit);
				child.off("error", onError);
			};
			lines.on("line", onLine);
			child.once("exit", onExit);
			child.once("error", onError);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	try {
		await request(
			"initialize",
			{
				protocolVersion: "1",
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
			},
			4_000,
		);
		return (await request("x.ai/billing", {}, 4_000)) as GrokBillingResult;
	} catch {
		return null;
	} finally {
		lines.close();
		child.kill();
	}
};

const RETRYABLE_STATUS = new Set([408, 502, 503, 504]);

export const fetchGrokCreditsWithRetry = async (
	input: Parameters<typeof fetch>[0],
	init: RequestInit,
	fetcher: typeof fetch = fetch,
): Promise<Response> => {
	try {
		const first = await fetcher(input, init);
		if (!RETRYABLE_STATUS.has(first.status)) return first;
	} catch {
		// A single retry handles transient network and timeout failures.
	}
	return fetcher(input, { ...init, signal: AbortSignal.timeout(5_000) });
};

export const readGrokAuthEntry = async (): Promise<AuthEntry | null> => {
	try {
		const parsed = JSON.parse(
			await readFile(
				join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json"),
				"utf8",
			),
		) as Record<string, AuthEntry>;
		const preferred = Object.entries(parsed).find(([key]) =>
			key.startsWith("https://auth.x.ai::"),
		)?.[1];
		return (
			preferred ??
			parsed["https://accounts.x.ai/sign-in"] ??
			Object.values(parsed)[0] ??
			null
		);
	} catch {
		return null;
	}
};

const readVarint = (bytes: Uint8Array, start: number): [number, number] => {
	let value = 0;
	let shift = 0;
	let index = start;
	while (index < bytes.length) {
		const byte = bytes[index++] ?? 0;
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}
	return [value, index];
};

export const parseGrokCreditsFrame = (
	bytes: Uint8Array,
	now = Date.now(),
): { usedPercent: number | null; resetsAt: string | null } => {
	const percents: Array<{ value: number; path: number[] }> = [];
	const resets: Array<{ value: number; path: number[] }> = [];
	const visit = (message: Uint8Array, path: number[]): void => {
		if (path.length > 8) return;
		for (let index = 0; index < message.length; ) {
			const [tag, next] = readVarint(message, index);
			index = next;
			const field = tag >>> 3;
			if (field === 0) break;
			const nextPath = [...path, field];
			const wire = tag & 7;
			if (wire === 5 && index + 4 <= message.length) {
				const value = new DataView(
					message.buffer,
					message.byteOffset + index,
					4,
				).getFloat32(0, true);
				if (Number.isFinite(value) && value >= 0 && value <= 100 && field === 1)
					percents.push({ value, path: nextPath });
				index += 4;
			} else if (wire === 0) {
				const [value, end] = readVarint(message, index);
				index = end;
				if (
					value >= 1_700_000_000 &&
					value <= 2_100_000_000 &&
					value * 1_000 > now
				)
					resets.push({ value, path: nextPath });
			} else if (wire === 2) {
				const [length, end] = readVarint(message, index);
				const finish = Math.min(message.length, end + length);
				visit(message.subarray(end, finish), nextPath);
				index = finish;
			} else if (wire === 1) index += 8;
			else break;
		}
	};
	visit(bytes, []);
	percents.sort((a, b) => a.path.length - b.path.length || a.value - b.value);
	const preferredReset = resets.find(
		(candidate) => candidate.path.join(".") === "1.5.1",
	);
	resets.sort((a, b) => a.path.length - b.path.length);
	const reset = preferredReset?.value ?? resets[0]?.value ?? null;
	return {
		usedPercent: percents[0]?.value ?? (reset ? 0 : null),
		resetsAt: reset ? new Date(reset * 1_000).toISOString() : null,
	};
};

export const parseGrokCreditsResponse = (
	bytes: Uint8Array,
	now = Date.now(),
): {
	usedPercent: number | null;
	resetsAt: string | null;
	grpcStatus: number | null;
} => {
	const payloads: Uint8Array[] = [];
	let grpcStatus: number | null = null;
	for (let index = 0; index + 5 <= bytes.length; ) {
		const flags = bytes[index] ?? 0;
		const length = new DataView(
			bytes.buffer,
			bytes.byteOffset + index + 1,
			4,
		).getUint32(0);
		const start = index + 5;
		const end = Math.min(bytes.length, start + length);
		const frame = bytes.subarray(start, end);
		if ((flags & 0x80) === 0) payloads.push(frame);
		else {
			const match = new TextDecoder()
				.decode(frame)
				.match(/(?:^|\r?\n)grpc-status:\s*(\d+)/i);
			if (match?.[1]) grpcStatus = Number.parseInt(match[1], 10);
		}
		index = end;
	}
	return {
		...parseGrokCreditsFrame(
			payloads.length > 0
				? Uint8Array.from(payloads.flatMap((part) => [...part]))
				: bytes,
			now,
		),
		grpcStatus,
	};
};

export const fetchGrokUsage = async (): Promise<ProviderUsageLimits> => {
	const auth = await readGrokAuthEntry();
	if (!auth?.key) return unavailable("grok", "no-credentials");
	if (
		auth.expires_at &&
		auth.expires_at * (auth.expires_at < 10_000_000_000 ? 1_000 : 1) <
			Date.now()
	)
		return unavailable("grok", "expired");
	try {
		const cli = await fetchGrokCliBilling();
		const parsed = cli ? mapGrokBillingResult(cli) : null;
		const response = parsed
			? null
			: await fetchGrokCreditsWithRetry(
					"https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${auth.key}`,
							"Content-Type": "application/grpc-web+proto",
							"x-grpc-web": "1",
							"x-user-agent": "connect-es/2.1.1",
							Origin: "https://grok.com",
							Referer: "https://grok.com/?_s=usage",
						},
						body: new Uint8Array(5),
						signal: AbortSignal.timeout(5_000),
					},
				);
		if (response && !response.ok)
			return unavailable(
				"grok",
				response.status === 401 || response.status === 403
					? "expired"
					: "error",
			);
		const webUsage = parsed
			? null
			: parseGrokCreditsResponse(
					new Uint8Array(await (response as Response).arrayBuffer()),
				);
		if (webUsage?.grpcStatus === 7 || webUsage?.grpcStatus === 16)
			return unavailable("grok", "expired");
		const usage = parsed ?? webUsage;
		if (!usage) return unavailable("grok", "error");
		const days = usage.resetsAt
			? (Date.parse(usage.resetsAt) - Date.now()) / 86_400_000
			: 0;
		return {
			providerId: "grok",
			planLabel: auth.auth_mode === "oidc" ? "SuperGrok" : null,
			creditsRemaining: null,
			fetchedAt: new Date().toISOString(),
			source: "api",
			windows: [
				{
					id: "credits",
					label: days >= 20 ? "Monthly" : days >= 4 ? "Weekly" : "Credits",
					scope: "overall",
					usedPercent: usage.usedPercent,
					resetsAt: usage.resetsAt,
					windowMinutes: days > 0 ? Math.round(days * 1_440) : null,
				},
			],
		};
	} catch {
		return unavailable("grok", "error");
	}
};
