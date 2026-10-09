import { describe, expect, it } from "vitest";
import { isolatedProviderAccountEnv } from "../../../src/drivers/provider-account-env.ts";

describe("provider account process environments", () => {
	it("isolates both Claude config and macOS secure storage and discards inherited tokens", () => {
		const base = {
			PATH: "/bin",
			ANTHROPIC_API_KEY: "default-key",
			CLAUDE_CODE_OAUTH_TOKEN: "default-token",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CONFIG_DIR: "/default",
		};
		const first = isolatedProviderAccountEnv("claude", "/accounts/work", base);
		const second = isolatedProviderAccountEnv(
			"claude",
			"/accounts/personal",
			base,
		);
		expect(first).toEqual({
			PATH: "/bin",
			CLAUDE_CONFIG_DIR: "/accounts/work",
			CLAUDE_SECURESTORAGE_CONFIG_DIR: "/accounts/work",
		});
		expect(second.CLAUDE_CONFIG_DIR).toBe("/accounts/personal");
		expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe("default-token");
	});
	it("isolates Codex storage without mutating the default process environment", () => {
		const base = {
			PATH: "/bin",
			CODEX_HOME: "/default",
			OPENAI_API_KEY: "default-key",
			CODEX_AUTH_JSON: "default-auth",
			CODEX_ACCESS_TOKEN: "default-token",
		};
		expect(isolatedProviderAccountEnv("codex", "/accounts/work", base)).toEqual(
			{ PATH: "/bin", CODEX_HOME: "/accounts/work" },
		);
		expect(base.CODEX_HOME).toBe("/default");
	});
});
