import { describe, expect, it } from "vitest";
import cloudSshSource from "../../src/lib/cloud-ssh-client-bus.ts?raw";

describe("cloud SSH readiness", () => {
	it("keeps a wake lease until the gateway authorizes the desktop key", () => {
		const retainGateway = cloudSshSource.indexOf("retainEnvironmentShell(");
		const waitForGateway = cloudSshSource.indexOf(
			"await waitForWorkspaceGateway(environmentId, retained.key)",
		);
		const requestAccess = cloudSshSource.indexOf(
			"access = await requestSshAccess(workspaceId)",
		);
		const authorizeKey = cloudSshSource.indexOf(
			"await dispatchEnvironmentShellCommand<",
		);
		const releaseGateway = cloudSshSource.indexOf("retained.lease.release()");

		expect(retainGateway).toBeGreaterThan(-1);
		expect(waitForGateway).toBeGreaterThan(retainGateway);
		expect(requestAccess).toBeGreaterThan(waitForGateway);
		expect(authorizeKey).toBeGreaterThan(requestAccess);
		expect(releaseGateway).toBeGreaterThan(authorizeKey);
	});
});
