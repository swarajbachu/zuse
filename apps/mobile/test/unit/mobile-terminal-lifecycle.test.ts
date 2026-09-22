import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const screenSource = (): string =>
	readFileSync(
		`${process.cwd()}/app/c/[conn]/session/[sessionId]/terminal.tsx`,
		"utf8",
	);

const developerToolsSource = (): string =>
	readFileSync(`${process.cwd()}/app/developer-tools.tsx`, "utf8");

describe("mobile terminal lifecycle UI", () => {
	it("exposes accessible rename and restart recovery controls", () => {
		const source = screenSource();
		expect(source).toContain('accessibilityLabel="Rename terminal"');
		expect(source).toContain('accessibilityLabel="Restart terminal"');
		expect(source).toContain("renameOwnedTerminal({");
		expect(source).toContain("restartOwnedTerminal({");
		expect(source).toContain("restartMobileTerminalResource(ref)");
	});

	it("scopes pending opens and async results to the current route identity", () => {
		const source = screenSource();
		expect(source).toContain("currentOpen?.routeIdentity === routeIdentity");
		expect(source).toContain("routeFenceRef.current.isCurrent(routeIdentity)");
		expect(source).toContain(
			"pendingOpenTokenRef.current?.routeIdentity === routeIdentity",
		);
	});

	it("scopes the PTY owner and catalog to the routed session", () => {
		const source = screenSource();
		expect(source).toContain("mobileTerminalOwnerId(deviceId, sessionKey)");
		expect(source).toContain(
			"listOwnedTerminals({ connection: options, ownerId })",
		);
	});

	it("lists developer terminals through the same session-scoped owners", () => {
		const source = developerToolsSource();
		expect(source).toContain("mobileTerminalOwnerId(deviceId, session.id)");
		expect(source).not.toContain(
			"PtyOwnerId.make(await getOrCreateDeviceId())",
		);
	});
});
