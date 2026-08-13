import { describe, expect, it } from "vitest";

import { deriveEnvironmentLocation } from "../../src/lib/environment-location.ts";
import type { EnvironmentCatalogEntry } from "../../src/store/environment-catalog.ts";

const entry = (
	overrides: Partial<EnvironmentCatalogEntry>,
): EnvironmentCatalogEntry => ({
	connectionKind: "relay",
	environmentId: "remote-one",
	profileId: null,
	label: "Build server",
	target: null,
	descriptor: null,
	status: "connected",
	error: null,
	...overrides,
});

describe("deriveEnvironmentLocation", () => {
	it("describes the physical desktop as local", () => {
		expect(
			deriveEnvironmentLocation({
				activeEnvironmentId: "local-one",
				localEnvironmentId: "local-one",
				activeEntry: entry({
					connectionKind: "local",
					environmentId: "local-one",
					label: "My Mac",
				}),
			}),
		).toEqual({ isLocal: true, label: "Local", menuLabel: "This Mac" });
	});

	it("shows the selected remote computer's real name", () => {
		expect(
			deriveEnvironmentLocation({
				activeEnvironmentId: "remote-one",
				localEnvironmentId: "local-one",
				activeEntry: entry({ label: "whizzy" }),
			}),
		).toEqual({ isLocal: false, label: "whizzy", menuLabel: "whizzy" });
	});

	it("does not claim an unknown remote environment is local", () => {
		expect(
			deriveEnvironmentLocation({
				activeEnvironmentId: "remote-missing",
				localEnvironmentId: "local-one",
				activeEntry: null,
			}),
		).toEqual({
			isLocal: false,
			label: "Remote computer",
			menuLabel: "Remote computer",
		});
	});
});
