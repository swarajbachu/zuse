import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import { describe, expect, it } from "vitest";

import { connectionNotice } from "../../src/lib/connection-notice";

const snapshot = (patch: Partial<ConnectionSnapshot>): ConnectionSnapshot => ({
	key: "mac",
	status: "connected",
	generation: 1,
	attempt: 0,
	error: null,
	...patch,
});

describe("connection notice", () => {
	it("stays quiet while connected", () => {
		expect(connectionNotice(snapshot({}), "Studio")).toBeNull();
	});

	it("calls a socket swap without a failure connecting", () => {
		expect(
			connectionNotice(snapshot({ status: "reconnecting" }), "Studio"),
		).toMatchObject({
			tone: "progress",
			title: "Connecting to Studio…",
			canRetry: false,
		});
	});

	it("reserves reconnecting for failed attempts", () => {
		expect(
			connectionNotice(
				snapshot({ status: "reconnecting", attempt: 4, error: "closed" }),
				"Studio",
			),
		).toMatchObject({ title: "Reconnecting to Studio…", canRetry: false });
	});

	it("offers retry once failures persist", () => {
		expect(
			connectionNotice(
				snapshot({ status: "reconnecting", attempt: 5, error: "closed" }),
				"Studio",
			),
		).toMatchObject({
			tone: "progress",
			title: "Can’t reach Studio",
			canRetry: true,
			canPairAgain: true,
		});
	});

	it("shows exhausted connections as a problem", () => {
		expect(
			connectionNotice(snapshot({ status: "error", error: null }), "Studio"),
		).toMatchObject({ tone: "problem", canRetry: true });
	});
});
