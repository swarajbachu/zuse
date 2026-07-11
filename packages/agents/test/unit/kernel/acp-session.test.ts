import { describe, expect, it, vi } from "vitest";
import { createAcpSession } from "../../../src/kernel/acp-session.ts";

const baseOptions = {
	cwd: "/tmp/project",
	sessionId: "session-1",
	providerLabel: "Provider",
	httpServers: [],
	fallbackServers: async () => [],
} as const;

describe("ACP session acquisition", () => {
	it("loads a persisted provider cursor instead of creating a new session", async () => {
		const request = vi.fn(async (method: string) => {
			if (method === "session/load") return { sessionId: "provider-cursor" };
			throw new Error(`Unexpected method ${method}`);
		});

		await expect(
			createAcpSession({
				...baseOptions,
				request,
				resumeCursor: "provider-cursor",
			}),
		).resolves.toEqual({ sessionId: "provider-cursor", resumed: true });
		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith("session/load", {
			sessionId: "provider-cursor",
			cwd: "/tmp/project",
			mcpServers: [],
		});
	});

	it("creates a replacement session when the saved cursor is unavailable", async () => {
		const request = vi.fn(async (method: string) => {
			if (method === "session/load") throw new Error("cursor expired");
			if (method === "session/new") return { sessionId: "replacement" };
			throw new Error(`Unexpected method ${method}`);
		});

		await expect(
			createAcpSession({
				...baseOptions,
				request,
				resumeCursor: "expired",
			}),
		).resolves.toEqual({ sessionId: "replacement", resumed: false });
		expect(request.mock.calls.map(([method]) => method)).toEqual([
			"session/load",
			"session/new",
		]);
	});
});
