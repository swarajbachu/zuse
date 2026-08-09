import { describe, expect, it } from "vitest";

import {
	extractClaudeSetupToken,
	getAccountAccessLoginCommand,
	parseClaudeSetupFailure,
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
		expect(
			parseClaudeSetupVerification(
				"\u001b]8;id=login;https://claude.com/cai/oauth/authorize?code=true\u0007Open authorization\u001b]8;;\u0007",
			),
		).toEqual({
			url: "https://claude.com/cai/oauth/authorize?code=true",
		});
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
				"codex",
				"\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m \u001b[94mHH9Y-43O37\u001b[0m",
			),
		).toEqual({
			url: "https://auth.openai.com/codex/device",
			code: "HH9Y-43O37",
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
		expect(extractClaudeSetupToken(`Token: ${token}\u001b[39m`)).toBe(token);
		expect(redactAccountAccessOutput(`Token: ${token}\u001b[39m`)).toBe(
			"Token: [credential redacted]\u001b[39m",
		);
		expect(extractClaudeSetupToken(`Token: ${token.slice(0, 32)}`)).toBeNull();
		expect(redactAccountAccessOutput(`Token: ${token.slice(0, 32)}`)).toBe(
			"Token: [credential redacted]",
		);
	});

	it("captures and redacts a setup token wrapped by the interactive terminal", () => {
		const token =
			"sk-ant-oat01-super-secret-value-that-is-long-enough-to-wrap-in-a-terminal";
		const wrapped = `Token: \u001b[33m${token.slice(0, 48)}\r\n${token.slice(48)}\u001b[39m`;

		expect(extractClaudeSetupToken(wrapped)).toBe(token);
		expect(redactAccountAccessOutput(wrapped)).not.toContain("super-secret");
		expect(redactAccountAccessOutput(wrapped)).not.toContain("terminal");
	});

	it("classifies safe Claude setup failures without forwarding terminal output", () => {
		expect(parseClaudeSetupFailure("Invalid code. Copy the full code.")).toBe(
			"invalid-code",
		);
		expect(
			parseClaudeSetupFailure(
				"Failed to exchange authorization code for access token.",
			),
		).toBe("exchange-failed");
		expect(parseClaudeSetupFailure("unrecognized terminal output")).toBeNull();
	});
});
