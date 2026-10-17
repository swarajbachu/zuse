import type { SimulatorState } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	groupSimulators,
	requirementSections,
	requirementsBlocked,
	setupSteps,
	simulatorPhase,
	simulatorSummary,
} from "../../src/lib/simulator-view.ts";

const ok = [
	{ id: "xcode", platform: "ios", ok: true, detail: "/Applications/Xcode.app" },
	{ id: "runtime", platform: "ios", ok: true, detail: "2 iOS simulators" },
	{ id: "android-sdk", platform: "android", ok: true, detail: "~/Android/Sdk" },
	{ id: "android-avd", platform: "android", ok: true, detail: "1 emulator" },
	{ id: "node", platform: "all", ok: true, detail: "Node 24" },
] as const;
const state = (patch: Partial<SimulatorState> = {}): SimulatorState => ({
	enabled: false,
	agentAccessEnabled: false,
	onboardingCompleted: false,
	status: "disabled",
	detail: "",
	requirements: ok,
	agentStatus: "off",
	agentDetail: "",
	tools: { hub: "1.0.0", agent: "2.0.0" },
	devices: [],
	sessions: [],
	revision: 1,
	...patch,
});
const missing = (...ids: string[]) =>
	ok.map((item) => (ids.includes(item.id) ? { ...item, ok: false } : item));

describe("simulator presentation", () => {
	it("routes host states to one pane phase", () => {
		expect(simulatorPhase(null, "loading")).toBe("loading");
		expect(simulatorPhase(null, "failed")).toBe("offline");
		expect(simulatorPhase(state(), "live")).toBe("setup");
		expect(
			simulatorPhase(state({ enabled: true, status: "idle" }), "live"),
		).toBe("preparing");
		expect(
			simulatorPhase(state({ enabled: true, status: "error" }), "live"),
		).toBe("failed");
		expect(
			simulatorPhase(state({ enabled: true, status: "ready" }), "live"),
		).toBe("ready");
	});

	it("needs Node and one platform, never a runtime or an emulator", () => {
		expect(requirementsBlocked(state())).toBe(false);
		expect(
			requirementsBlocked(
				state({ requirements: missing("runtime", "android-avd") }),
			),
		).toBe(false);
		// Android alone is enough, e.g. on Linux or a Mac without Xcode.
		expect(
			requirementsBlocked(state({ requirements: missing("xcode", "runtime") })),
		).toBe(false);
		expect(
			requirementsBlocked(
				state({ requirements: missing("xcode", "android-sdk") }),
			),
		).toBe(true);
		expect(requirementsBlocked(state({ requirements: missing("node") }))).toBe(
			true,
		);
	});

	it("groups requirements by platform in display order", () => {
		expect(
			requirementSections([ok[4], ok[2], ok[0]]).map((section) => [
				section.platform,
				section.items.map((item) => item.id),
			]),
		).toEqual([
			["ios", ["xcode"]],
			["android", ["android-sdk"]],
			["all", ["node"]],
		]);
	});

	it("derives setup progress, including agent tools only when requested", () => {
		const hub = setupSteps(state({ enabled: true, status: "installing" }));
		expect(hub.map((step) => step.state)).toEqual([
			"done",
			"active",
			"pending",
			"pending",
		]);
		const agents = setupSteps(
			state({
				enabled: true,
				agentAccessEnabled: true,
				status: "ready",
				agentStatus: "installing",
			}),
		);
		expect(agents.map((step) => step.state)).toEqual([
			"done",
			"done",
			"done",
			"done",
			"active",
		]);
		expect(agents.at(-1)?.label).toContain("2.0.0");
	});

	it("lists iOS before Android, newest runtime first, running devices leading", () => {
		const groups = groupSimulators([
			{
				id: "p",
				platform: "android",
				name: "Pixel",
				version: "Android 15.0",
				booted: false,
			},
			{
				id: "a",
				platform: "ios",
				name: "iPhone B",
				version: "iOS 18.6",
				booted: false,
			},
			{
				id: "b",
				platform: "ios",
				name: "iPhone Z",
				version: "iOS 26.1",
				booted: false,
			},
			{
				id: "c",
				platform: "ios",
				name: "iPhone Y",
				version: "iOS 26.1",
				booted: true,
			},
			{
				id: "d",
				platform: "ios",
				name: "iPhone A",
				version: "iOS 26.1",
				booted: false,
			},
			{
				id: "q",
				platform: "android",
				name: "Tablet",
				version: "Android 16.0",
				booted: false,
			},
		]);
		expect(groups.map((group) => group.runtime)).toEqual([
			"iOS 26.1",
			"iOS 18.6",
			"Android 16.0",
			"Android 15.0",
		]);
		expect(groups[0]?.devices.map((device) => device.id)).toEqual([
			"c",
			"d",
			"b",
		]);
	});

	it("summarizes a ready host by device and running count", () => {
		expect(
			simulatorSummary(
				state({
					enabled: true,
					status: "ready",
					devices: [
						{
							id: "a",
							platform: "ios",
							name: "A",
							version: "iOS 26",
							booted: true,
						},
						{
							id: "b",
							platform: "android",
							name: "B",
							version: "Android 15.0",
							booted: false,
						},
					],
				}),
			),
		).toBe("2 devices · 1 running");
	});
});
