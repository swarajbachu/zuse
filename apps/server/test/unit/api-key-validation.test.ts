import {
	AuthenticationError,
	CursorSdkError,
	NetworkError,
	RateLimitError,
	type Run,
	type SDKAgent,
} from "@cursor/sdk";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	create: vi.fn(),
	listModels: vi.fn(),
}));

vi.mock("@cursor/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cursor/sdk")>();
	return {
		...actual,
		Agent: { ...actual.Agent, create: sdk.create },
		Cursor: {
			...actual.Cursor,
			models: { list: sdk.listModels },
		},
	};
});

import {
	classifyApiKeyValidationError,
	validateApiKey,
} from "../../src/provider/api-key-validation.ts";

const successfulProbeAgent = () => {
	const run = {
		status: "finished",
		async *stream() {
			yield {
				type: "assistant",
				agent_id: "probe-agent",
				run_id: "probe-run",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ZUSE_READY" }],
				},
			};
		},
		wait: vi.fn().mockResolvedValue({ id: "probe-run", status: "finished" }),
		cancel: vi.fn().mockResolvedValue(undefined),
	} as unknown as Run;
	const agent = {
		agentId: "probe-agent",
		send: vi.fn().mockResolvedValue(run),
		close: vi.fn(),
	} as unknown as SDKAgent;
	return { agent, run };
};

describe("API-key validation classification", () => {
	beforeEach(() => {
		sdk.create.mockReset();
		sdk.listModels.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		new AuthenticationError("Invalid API key"),
		new CursorSdkError("Unauthorized", { status: 401 }),
		new Error("API key was revoked"),
	])("rejects confirmed authentication failures", (error) => {
		expect(classifyApiKeyValidationError(error)).toEqual({
			status: "invalid",
			reason: "The API key was rejected. Check the key and try again.",
		});
	});

	it.each([
		new NetworkError("Network unavailable", { status: 503 }),
		new RateLimitError("Rate limited", { status: 429 }),
		new CursorSdkError("Server failure", { status: 500 }),
		new Error("Request timed out"),
		new Error("Unexpected SDK failure"),
	])("keeps non-authentication failures non-blocking", (error) => {
		expect(classifyApiKeyValidationError(error).status).toBe("unverified");
	});

	it("marks a key verified only after a real local SDK message succeeds", async () => {
		const { agent } = successfulProbeAgent();
		sdk.listModels.mockResolvedValue([
			{ id: "composer-2", displayName: "Composer" },
		]);
		sdk.create.mockResolvedValue(agent);

		await expect(
			Effect.runPromise(validateApiKey("managed-key")),
		).resolves.toEqual({ status: "verified" });
		expect(agent.send).toHaveBeenCalledWith(
			expect.stringContaining("ZUSE_READY"),
			expect.objectContaining({ model: { id: "composer-2" } }),
		);
		expect(agent.close).toHaveBeenCalledOnce();
	});

	it("does not report ready when model listing works but the message probe fails", async () => {
		sdk.listModels.mockResolvedValue([
			{ id: "composer-2", displayName: "Composer" },
		]);
		sdk.create.mockRejectedValue(new Error("Local runtime failed to start"));

		await expect(
			Effect.runPromise(validateApiKey("managed-key")),
		).resolves.toMatchObject({ status: "unverified" });
	});

	it.each([
		"BAD_API_KEY",
		"BAD_USER_API_KEY",
	])("rejects the SDK's %s message failure", async (code) => {
		const { agent, run } = successfulProbeAgent();
		vi.mocked(run.wait).mockResolvedValue({
			id: "probe-run",
			status: "error",
			error: { message: "Run failed", code },
		});
		sdk.listModels.mockResolvedValue([
			{ id: "composer-2", displayName: "Composer" },
		]);
		sdk.create.mockResolvedValue(agent);

		await expect(
			Effect.runPromise(validateApiKey("rejected-key")),
		).resolves.toMatchObject({ status: "invalid" });
	});

	it("does not start a late agent after the readiness deadline", async () => {
		vi.useFakeTimers();
		let resolveModels:
			| ((models: Array<{ id: string; displayName: string }>) => void)
			| undefined;
		sdk.listModels.mockReturnValue(
			new Promise((resolve) => {
				resolveModels = resolve;
			}),
		);

		const validation = Effect.runPromise(validateApiKey("managed-key"));
		await vi.advanceTimersByTimeAsync(20_000);
		await expect(validation).resolves.toMatchObject({ status: "unverified" });

		resolveModels?.([{ id: "composer-2", displayName: "Composer" }]);
		await Promise.resolve();
		await Promise.resolve();
		expect(sdk.create).not.toHaveBeenCalled();
	});
});
