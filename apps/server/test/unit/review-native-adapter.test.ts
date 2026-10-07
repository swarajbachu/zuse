import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvestigatorInput, VerifierInput } from "@zuse/review";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
	const results: unknown[] = [];
	const calls: unknown[][] = [];
	const errors: string[] = [];
	return { results, calls, errors, closed: vi.fn(), validated: vi.fn() };
});
vi.mock("@zuse/agents/review/claude-profile", () => ({
	validateNativeReviewProfile: native.validated,
	createNativeReviewQuery: (...args: unknown[]) => {
		native.calls.push(args);
		return {
			query: (async function* () {
				if (native.errors.length)
					yield { type: "assistant", error: native.errors.shift() };
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					structured_output: native.results.shift(),
				};
			})(),
			close: async () => {
				native.closed();
			},
		};
	},
}));

import {
	classifyNativeReviewFailure,
	createNativeReviewFactory,
} from "../../src/review/native-adapter.ts";

const snapshot = {
	repositoryId: 1,
	baseRef: "main",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	mergeBaseSha: "a".repeat(40),
};
const binding = {
	runId: "run",
	connectionId: "connection",
	providerId: "claude",
	model: "test",
	snapshot,
};
const tools = {
	read: async () => "source",
	search: async () => [],
	relatedFiles: async () => [],
};
const roots: string[] = [];
beforeEach(() => {
	native.calls.length = 0;
	native.results.length = 0;
	native.errors.length = 0;
	native.closed.mockClear();
	native.validated.mockClear();
});
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function factory() {
	const trustedCwd = await mkdtemp(join(tmpdir(), "review-native-test-"));
	roots.push(trustedCwd);
	const assertCurrent = vi.fn(async () => {});
	const onFailure = vi.fn();
	return {
		value: createNativeReviewFactory(
			{
				authHome: "/fixture-auth",
				executablePath: "/fixture-claude",
				trustedCwd,
				model: "test",
			},
			assertCurrent,
			onFailure,
		),
		trustedCwd,
		assertCurrent,
		onFailure,
	};
}
const investigation: InvestigatorInput = {
	snapshot,
	tools,
	changes: [],
	signal: new AbortController().signal,
	repositoryContext: {
		trust: "repository-data",
		entries: [],
		presentFiles: [],
		omittedEntries: 0,
		unreadablePaths: [],
		limited: false,
		resolution: "declared-config-only",
	},
};
const verification: VerifierInput = {
	snapshot,
	tools,
	signal: new AbortController().signal,
	candidate: {
		id: "candidate",
		severity: "high",
		title: "Bug",
		explanation: "Bug explanation",
		trigger: "Input",
		consequence: "Crash",
		location: { path: "a.ts", side: "RIGHT", startLine: 1, endLine: 1 },
		evidence: [
			{
				path: "a.ts",
				side: "RIGHT",
				startLine: 1,
				endLine: 1,
				quote: "source",
			},
		],
	},
};
describe("native structured review adapter", () => {
	it("executes a real query contract and creates fresh verification context", async () => {
		const instance = await factory();
		native.results.push(
			{ findings: [], reviewedPaths: [] },
			{ verdict: "confirmed" },
		);
		const first = await instance.value.open({
			binding,
			role: "investigator",
			signal: investigation.signal,
		});
		await expect(first.investigate(investigation)).resolves.toEqual({
			findings: [],
			reviewedPaths: [],
		});
		await first.close();
		const second = await instance.value.open({
			binding,
			role: "verifier",
			signal: verification.signal,
		});
		await expect(second.verify(verification)).resolves.toBe("confirmed");
		await second.close();
		expect(native.calls).toHaveLength(2);
		expect(native.calls[0]?.[0]).not.toEqual(native.calls[1]?.[0]);
		expect(native.calls[1]?.[2]).toContain('"candidate"');
		expect(native.calls[1]?.[2]).not.toContain('"repositoryContext"');
		expect(instance.assertCurrent).toHaveBeenCalledTimes(2);
		expect(native.closed).toHaveBeenCalledTimes(2);
		expect(await readdir(instance.trustedCwd)).toEqual([]);
	});
	it("rejects reuse and malformed verdict", async () => {
		const instance = await factory();
		native.results.push({ verdict: "maybe" });
		const session = await instance.value.open({
			binding,
			role: "verifier",
			signal: verification.signal,
		});
		await expect(session.verify(verification)).rejects.toThrow(
			"Invalid native",
		);
		await expect(session.verify(verification)).rejects.toThrow("consumed");
		await session.close();
	});
	it("rejects a wrong provider before starting native process", async () => {
		const instance = await factory();
		await expect(
			instance.value.open({
				binding: { ...binding, providerId: "codex" },
				role: "investigator",
				signal: investigation.signal,
			}),
		).rejects.toThrow("mismatch");
		expect(native.calls).toEqual([]);
	});
});

describe("typed native failure classification", () => {
	it("propagates quota failures without provider text and closes the session", async () => {
		const instance = await factory();
		native.errors.push("rate_limit");
		const session = await instance.value.open({
			binding,
			role: "investigator",
			signal: investigation.signal,
		});
		await expect(session.investigate(investigation)).rejects.toThrow(
			"Native provider request failed",
		);
		await session.close();
		expect(instance.onFailure).toHaveBeenCalledWith("review_quota_exhausted");
		expect(native.closed).toHaveBeenCalledOnce();
	});
	it.each([
		"authentication_failed",
		"oauth_org_not_allowed",
		"account_on_hold",
		"verification_required",
		"cloud_credential_error",
	])("requires reconnect for %s", (code) => {
		expect(classifyNativeReviewFailure(code)).toBe("review_reconnect_required");
	});
	it.each([
		"rate_limit",
		"billing_error",
	])("stops quota usage for %s", (code) => {
		expect(classifyNativeReviewFailure(code)).toBe("review_quota_exhausted");
	});
	it("never exposes raw error strings", () => {
		expect(
			classifyNativeReviewFailure("a secret-looking provider message"),
		).toBe("review_native_failed");
	});
});
