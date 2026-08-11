import type { MachineRecord } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	cloudMachineProgress,
	cloudMachineProgressSteps,
} from "../../src/lib/cloud-machine-progress.ts";

const progressFor = (
	state: MachineRecord["state"],
	statusCode: MachineRecord["statusCode"],
	bootPhase?: MachineRecord["bootPhase"],
) => cloudMachineProgress({ state, statusCode, bootPhase });

describe("cloud machine progress", () => {
	it("shows payment as confirmed while the server is queued", () => {
		expect(progressFor("creating", "creation-queued")).toEqual({
			activeStep: 1,
			detail: "Your server is queued and will be created automatically.",
			headline: "Payment confirmed",
			label: "Provisioning",
			tone: "progress",
		});
	});

	it("explains an automatic provider retry instead of appearing frozen", () => {
		expect(progressFor("creating", "provider-unavailable")).toEqual({
			activeStep: 1,
			detail:
				"The provider connection was interrupted. We are retrying automatically; no action is needed.",
			headline: "Still creating your server",
			label: "Retrying automatically",
			tone: "warning",
		});
	});

	it("advances through runtime installation and enrollment", () => {
		expect(progressFor("bootstrapping", "bootstrap-pending").activeStep).toBe(
			2,
		);
		expect(
			progressFor("bootstrapping", "bootstrap-pending", "runtime-installed"),
		).toMatchObject({
			activeStep: 3,
			headline: "Installing developer tools",
		});
		expect(
			progressFor(
				"bootstrapping",
				"bootstrap-pending",
				"developer-tools-installed",
			),
		).toMatchObject({ activeStep: 4, headline: "Starting Zuse" });
		expect(progressFor("enrolling", "enrollment-pending").activeStep).toBe(5);
	});

	it("marks all setup stages complete when ready", () => {
		expect(progressFor("ready", "ready")).toMatchObject({
			activeStep: 6,
			headline: "Your cloud machine is ready",
			label: "Ready",
			tone: "success",
		});
	});

	it("does not mark Ready as current during post-setup lifecycle changes", () => {
		expect(
			progressFor("suspended", "recovery-available").activeStep,
		).toBeNull();
		expect(
			progressFor("destroying", "destruction-queued").activeStep,
		).toBeNull();
	});

	it("makes exhausted reconciliation visible as an actionable failure", () => {
		expect(progressFor("failed", "reconciliation-failed")).toMatchObject({
			headline: "Provisioning needs attention",
			label: "Setup interrupted",
			tone: "error",
		});
	});

	it("uses the persistent server setup steps", () => {
		expect(cloudMachineProgressSteps()).toHaveLength(7);
	});
});
