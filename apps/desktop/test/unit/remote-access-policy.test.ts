import { describe, expect, it } from "vitest";
import { desktopRemoteAccessPolicy } from "../../src/remote-access-policy.ts";

describe("desktop remote access defaults", () => {
	it("does not register development copies or resume their saved tunnels", () => {
		expect(desktopRemoteAccessPolicy(true, {})).toEqual({
			autoLink: false,
			resumeLink: false,
		});
	});
	it("keeps the installed desktop as the remote contact", () => {
		expect(desktopRemoteAccessPolicy(false, {})).toEqual({
			autoLink: true,
			resumeLink: true,
		});
	});
	it("allows explicitly testing remote access in a development copy", () => {
		expect(
			desktopRemoteAccessPolicy(true, { ZUSE_DEV_REMOTE_ACCESS: "1" }),
		).toEqual({ autoLink: true, resumeLink: true });
	});
	it("does not accidentally enable remote access with a truthy string", () => {
		for (const value of ["0", "false", "true", ""]) {
			expect(
				desktopRemoteAccessPolicy(true, { ZUSE_DEV_REMOTE_ACCESS: value })
					.autoLink,
			).toBe(false);
		}
	});
});
