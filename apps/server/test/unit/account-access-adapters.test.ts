import { describe, expect, it } from "vitest";

import {
	extractClaudeSetupToken,
	getAccountAccessLoginCommand,
	parseClaudeSetupVerification,
	parseDeviceLoginVerification,
	redactAccountAccessOutput,
} from "../../src/account-access/adapters.ts";

describe("account-access provider adapters", () => {
	it("uses native device authorization for GitHub and Codex", () => {
		expect(getAccountAccessLoginCommand("github")).toEqual({
			command: "gh",
			environment: { GH_PROMPT_DISABLED: "1" },
			args: [
				"auth",
				"login",
				"--hostname",
				"github.com",
				"--git-protocol",
				"https",
				"--web",
			],
		});
		expect(getAccountAccessLoginCommand("codex")).toEqual({
			command: "codex",
			args: ["login", "--device-auth"],
		});
	});

	it("only exposes approved Claude setup URLs", () => {
		expect(
			parseClaudeSetupVerification(
				"Open https://console.anthropic.com/oauth/authorize and enter ABCD-EFGH",
			),
		).toEqual({
			url: "https://console.anthropic.com/oauth/authorize",
			code: "ABCD-EFGH",
		});
		expect(
			parseClaudeSetupVerification("Open https://attacker.invalid/steal"),
		).toEqual({});
	});

	it("extracts only provider-approved verification URLs and short codes", () => {
		expect(
			parseDeviceLoginVerification(
				"github",
				"Copy ABCD-EFGH and open https://github.com/login/device",
			),
		).toEqual({
			url: "https://github.com/login/device",
			code: "ABCD-EFGH",
		});
		expect(
			parseDeviceLoginVerification(
				"codex",
				"Open https://auth.openai.com/codex/device and enter WXYZ-1234",
			),
		).toEqual({
			url: "https://auth.openai.com/codex/device",
			code: "WXYZ-1234",
		});
		expect(
			parseDeviceLoginVerification(
				"github",
				"Open https://phishing.example/login and enter ABCD-EFGH",
			),
		).toEqual({ code: "ABCD-EFGH" });
	});

	it("captures setup-token output without allowing the credential into logs", () => {
		const token = "sk-ant-oat01-super-secret-value-that-is-long-enough";
		expect(extractClaudeSetupToken(`Token: ${token}`)).toBe(token);
		expect(redactAccountAccessOutput(`Token: ${token}`)).toBe(
			"Token: [credential redacted]",
		);
	});
});
