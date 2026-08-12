import { describe, expect, it } from "vitest";
import {
	runtimeActivityLifecycle,
	runtimeReadyStatusCode,
} from "../../src/cloud-workspace-routes.ts";

describe("cloud workspace runtime ready status", () => {
	it("keeps a resumed workspace running after its start command was acknowledged", () => {
		expect(runtimeReadyStatusCode("repository-ready", "acknowledged")).toBe(
			"agent-running",
		);
	});

	it("waits for the first agent start on a new workspace", () => {
		expect(runtimeReadyStatusCode("repository-ready", undefined)).toBe(
			"agent-starting",
		);
		expect(runtimeReadyStatusCode("agent-started", undefined)).toBe(
			"agent-running",
		);
	});

	it("treats authenticated runtime traffic as a successful warm resume", () => {
		expect(
			runtimeActivityLifecycle({
				state: "resuming",
				desiredState: "ready",
				runtimeState: "connecting",
				statusCode: "resume-runtime-waking",
			}),
		).toEqual({
			state: "ready",
			runtimeState: "online",
			statusCode: "agent-running",
		});
		expect(
			runtimeActivityLifecycle({
				state: "provisioning",
				desiredState: "ready",
				runtimeState: "offline",
				statusCode: "resume-runtime-restarting",
			}),
		).toEqual({
			state: "ready",
			runtimeState: "online",
			statusCode: "agent-running",
		});
	});
});
