import {
	isSensitivePath,
	SENSITIVE_PATH_PATTERNS,
} from "@zuse/agents/kernel/permission-policy";
import { getBashPolicy, getFsPolicy } from "@zuse/agents/kernel/policy";
import type { PermissionMode, RuntimeMode } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
	"approval-required",
	"auto-accept-edits",
	"auto-accept-edits-and-bash",
	"full-access",
];

describe("isSensitivePath", () => {
	it("matches dotfiles and credential-bearing paths anywhere in the string", () => {
		const sensitive = [
			"/repo/.env",
			"/repo/.env.local",
			"~/.aws/credentials",
			"/home/u/.ssh/id_rsa",
			"/home/u/.ssh/id_ed25519.pub",
			"/secrets/credentials.json",
			"credentials",
			"/certs/server.pem",
			"/certs/server.key",
			"/certs/bundle.p12",
			"/certs/bundle.pfx",
			"/home/u/.netrc",
			"/home/u/.pgpass",
		];
		for (const p of sensitive) {
			expect(isSensitivePath(p)).toBe(true);
		}
	});

	it("does not match ordinary source paths", () => {
		const safe = [
			"/repo/src/index.ts",
			"/repo/environment.ts", // not `.env`
			"/repo/README.md",
			"/repo/package.json",
			"/repo/.envrc.example.ts", // `.env` not followed by `.` or end
			"",
		];
		for (const p of safe) {
			expect(isSensitivePath(p)).toBe(false);
		}
	});

	it("SENSITIVE_PATH_PATTERNS is non-empty and drives isSensitivePath", () => {
		expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
		expect(SENSITIVE_PATH_PATTERNS.some((re) => re.test("/repo/.env"))).toBe(
			true,
		);
	});
});

describe("getFsPolicy", () => {
	it("forces a prompt on sensitive paths under every runtime mode", () => {
		for (const mode of RUNTIME_MODES) {
			const policy = getFsPolicy("write", "/repo/.env", mode);
			expect(policy).toEqual({ kind: "prompt", forcePrompt: true });
		}
	});

	it("auto-allows reads regardless of runtime mode (non-sensitive)", () => {
		for (const mode of RUNTIME_MODES) {
			expect(getFsPolicy("read", "/repo/src/a.ts", mode)).toEqual({
				kind: "auto-allow",
			});
		}
	});

	it("reads of sensitive paths still prompt", () => {
		expect(getFsPolicy("read", "/repo/.env", "full-access")).toEqual({
			kind: "prompt",
			forcePrompt: true,
		});
	});

	it("plan mode forces a prompt for mutations even under full-access", () => {
		const policy = getFsPolicy(
			"write",
			"/repo/src/a.ts",
			"full-access",
			"plan",
		);
		expect(policy).toEqual({ kind: "prompt", forcePrompt: true });
	});

	it("auto-accept-edits modes auto-allow non-sensitive mutations", () => {
		for (const mode of [
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
		] as const) {
			for (const op of ["write", "create", "delete", "move"] as const) {
				expect(getFsPolicy(op, "/repo/src/a.ts", mode)).toEqual({
					kind: "auto-allow",
				});
			}
		}
	});

	it("full-access auto-allows surviving (non-sensitive) mutations", () => {
		expect(getFsPolicy("write", "/repo/src/a.ts", "full-access")).toEqual({
			kind: "auto-allow",
		});
	});

	it("approval-required prompts (non-force) for non-sensitive mutations", () => {
		expect(getFsPolicy("write", "/repo/src/a.ts", "approval-required")).toEqual(
			{
				kind: "prompt",
				forcePrompt: false,
			},
		);
	});
});

describe("getBashPolicy", () => {
	it("plan mode always forces a prompt", () => {
		for (const mode of RUNTIME_MODES) {
			expect(getBashPolicy("rm -rf /", mode, "plan")).toEqual({
				kind: "prompt",
				forcePrompt: true,
			});
		}
	});

	it("full-access auto-allows commands", () => {
		expect(getBashPolicy("ls", "full-access")).toEqual({ kind: "auto-allow" });
	});

	it("auto-accept-edits still prompts for bash (only file edits are auto-accepted)", () => {
		expect(getBashPolicy("ls", "auto-accept-edits")).toEqual({
			kind: "prompt",
			forcePrompt: false,
		});
	});

	it("auto-accept-edits-and-bash auto-allows commands", () => {
		expect(getBashPolicy("ls", "auto-accept-edits-and-bash")).toEqual({
			kind: "auto-allow",
		});
	});

	it("approval-required prompts (non-force)", () => {
		expect(getBashPolicy("ls", "approval-required")).toEqual({
			kind: "prompt",
			forcePrompt: false,
		});
	});

	it("plan mode wins over full-access", () => {
		const mode: RuntimeMode = "full-access";
		const perm: PermissionMode = "plan";
		expect(getBashPolicy("ls", mode, perm)).toEqual({
			kind: "prompt",
			forcePrompt: true,
		});
	});
});
