import { describe, expect, test } from "vitest";

import { parseDeviceLoginOutput } from "../../src/cloud-auth-authority.ts";

describe("cloud auth device-login output", () => {
	test("extracts the official Codex URL and one-time code through ANSI styling", () => {
		const output = [
			"Follow these steps to sign in with ChatGPT using device code authorization:",
			"1. Open this link in your browser and sign in to your account",
			" \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
			"2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
			" \u001b[94mABCD-EFGH\u001b[0m",
		].join("\n");

		expect(parseDeviceLoginOutput(output)).toEqual({
			verificationUrl: "https://auth.openai.com/codex/device",
			verificationCode: "ABCD-EFGH",
		});
	});

	test("does not mistake device-code authorization prose for a code", () => {
		expect(
			parseDeviceLoginOutput(
				"Sign in with ChatGPT using device code authorization",
			),
		).toEqual({});
	});

	test("accepts an ungrouped code printed on the line after the prompt", () => {
		expect(
			parseDeviceLoginOutput(
				"2. Enter this one-time code (expires soon)\n A1B2C3D4\n",
			),
		).toEqual({ verificationCode: "A1B2C3D4" });
	});

	test("extracts a labeled Grok device code", () => {
		expect(
			parseDeviceLoginOutput(
				"Open https://auth.x.ai/device\nDevice code: WXYZ-1234\n",
			),
		).toEqual({
			verificationUrl: "https://auth.x.ai/device",
			verificationCode: "WXYZ-1234",
		});
	});
});
