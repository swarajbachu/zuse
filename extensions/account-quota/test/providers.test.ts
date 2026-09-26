import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readCredential } from "../index.server.ts";
import { fetchQuota, sources } from "../providers.ts";

it("reads independent Codex windows and Claude model allowances", async () => {
	const codex = JSON.parse(
		await readFile(new URL("../fixtures/codex.json", import.meta.url), "utf8"),
	);
	const claude = JSON.parse(
		await readFile(new URL("../fixtures/claude.json", import.meta.url), "utf8"),
	);
	expect(
		sources.codex.parse(codex).windows.map((w) => 100 - (w.usedPercent ?? 0)),
	).toEqual([76, 39]);
	expect(sources.claude.parse(claude).windows.map((w) => w.label)).toEqual([
		"Session",
		"Weekly",
		"sonnet",
	]);
	expect(
		sources.codex.parse({
			rate_limit: { primary_window: { used_percent: "bad", reset_at: "bad" } },
		}).windows[0],
	).toMatchObject({ usedPercent: null, resetsAt: null });
	expect(
		sources.claude.parse({ five_hour: { utilization: 120 } }).windows[0]
			.usedPercent,
	).toBe(100);
});
it("routes each profile token and account ID independently to the fixed provider origin", async () => {
	const request = vi.fn<typeof fetch>(
		async () =>
			new Response(
				JSON.stringify({
					rate_limit: { primary_window: { used_percent: 10 } },
				}),
			),
	);
	for (const id of ["work", "personal", "third", "fourth", "fifth"])
		await fetchQuota(
			"codex",
			{ tokens: { access_token: `token-${id}`, account_id: id } },
			new AbortController().signal,
			request,
		);
	expect(request).toHaveBeenCalledTimes(5);
	expect(request.mock.calls.map((c) => c[1]?.headers)).toEqual(
		["work", "personal", "third", "fourth", "fifth"].map((id) => ({
			Authorization: `Bearer token-${id}`,
			"ChatGPT-Account-Id": id,
		})),
	);
	expect(
		request.mock.calls.every(
			(c) =>
				c[0] === "https://chatgpt.com/backend-api/wham/usage" &&
				c[1]?.redirect === "error",
		),
	).toBe(true);
});
it("exposes explicit errors, never provider error bodies, and bounds response size", async () => {
	const credential = { tokens: { access_token: "secret", account_id: "work" } };
	const signal = new AbortController().signal;
	for (const [status, match] of [
		[401, "expired"],
		[403, "denied"],
		[429, "rate limited"],
	] as const) {
		await expect(
			fetchQuota(
				"codex",
				credential,
				signal,
				async () => new Response("private-token", { status }),
			),
		).rejects.toThrow(match);
	}
	await expect(
		fetchQuota(
			"codex",
			credential,
			signal,
			async () => new Response("x".repeat(262145)),
		),
	).rejects.toThrow("256 KiB");
	await expect(
		fetchQuota(
			"codex",
			credential,
			signal,
			async () => new Response("not JSON"),
		),
	).rejects.toThrow("malformed");
	await expect(
		fetchQuota("codex", credential, signal, async () => new Response("{}")),
	).rejects.toThrow("no supported");
	expect(() =>
		sources.claude.request({
			claudeAiOauth: { accessToken: "secret", expiresAt: 1 },
		}),
	).toThrow("expired");
	expect(() => sources.codex.request({ OPENAI_API_KEY: "secret" })).toThrow(
		"API keys",
	);
});
it("reads fresh credential files without changing them and rejects oversized or malformed files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "quota-test-"));
	const path = join(dir, "auth.json");
	try {
		await writeFile(path, '{"tokens":{"account_id":"one"}}');
		expect(await readCredential(path)).toEqual({
			tokens: { account_id: "one" },
		});
		await writeFile(path, '{"tokens":{"account_id":"two"}}');
		expect(await readCredential(path)).toEqual({
			tokens: { account_id: "two" },
		});
		await writeFile(path, "x".repeat(65537));
		await expect(readCredential(path)).rejects.toThrow("64 KiB");
		await writeFile(path, "bad");
		await expect(readCredential(path)).rejects.toThrow("invalid JSON");
		await expect(readCredential("relative.json")).rejects.toThrow("absolute");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
