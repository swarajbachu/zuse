import { describe, expect, it } from "vitest";
import { desktopRemoteAccessPolicy } from "../../src/remote-access-policy.ts";

describe("desktop remote access defaults", () => {
	it("does not register the installed app on startup but keeps its saved registration", () => {
		expect(desktopRemoteAccessPolicy(false, {})).toEqual({
			autoLink: false,
			resumeLink: true,
			retireLink: false,
		});
	});
	it("does not register development copies and retires their old registrations", () => {
		expect(desktopRemoteAccessPolicy(true, {})).toEqual({
			autoLink: false,
			resumeLink: false,
			retireLink: true,
		});
	});
	it("allows explicitly testing remote access in a development copy", () => {
		expect(
			desktopRemoteAccessPolicy(true, { ZUSE_DEV_REMOTE_ACCESS: "1" }),
		).toEqual({ autoLink: false, resumeLink: true, retireLink: false });
	});
	it("restores startup registration only when explicitly requested", () => {
		expect(
			desktopRemoteAccessPolicy(false, { ZUSE_DESKTOP_AUTO_LINK: "1" })
				.autoLink,
		).toBe(true);
		expect(
			desktopRemoteAccessPolicy(true, { ZUSE_DESKTOP_AUTO_LINK: "1" }).autoLink,
		).toBe(false);
		expect(
			desktopRemoteAccessPolicy(true, {
				ZUSE_DEV_REMOTE_ACCESS: "1",
				ZUSE_DESKTOP_AUTO_LINK: "1",
			}).autoLink,
		).toBe(true);
	});
	it("does not accidentally enable remote access with a truthy string", () => {
		for (const value of ["0", "false", "true", ""]) {
			const policy = desktopRemoteAccessPolicy(true, {
				ZUSE_DEV_REMOTE_ACCESS: value,
				ZUSE_DESKTOP_AUTO_LINK: value,
			});
			expect(policy.autoLink).toBe(false);
			expect(policy.resumeLink).toBe(false);
		}
	});
});
