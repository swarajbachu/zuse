import { describe, expect, it, vi } from "vitest";

import { openProjectForEnvironment } from "../../src/lib/project-opening.ts";

describe("project opening", () => {
	it("keeps the native picker for this Mac", () => {
		const openNativePicker = vi.fn();
		const openRemotePathDialog = vi.fn();

		expect(
			openProjectForEnvironment(null, {
				openNativePicker,
				openRemotePathDialog,
			}),
		).toBe("native-picker");
		expect(openNativePicker).toHaveBeenCalledOnce();
		expect(openRemotePathDialog).not.toHaveBeenCalled();
	});

	it("uses a remote path dialog for a cloud machine", () => {
		const openNativePicker = vi.fn();
		const openRemotePathDialog = vi.fn();

		expect(
			openProjectForEnvironment("env_cloud_1", {
				openNativePicker,
				openRemotePathDialog,
			}),
		).toBe("remote-path");
		expect(openRemotePathDialog).toHaveBeenCalledOnce();
		expect(openNativePicker).not.toHaveBeenCalled();
	});
});
