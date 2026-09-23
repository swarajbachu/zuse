/** Only known app notification destinations may navigate; legacy links land in the inbox. */
export const notificationRoute = (target: unknown): "/" | null => {
	if (typeof target !== "string") return null;
	try {
		const url = new URL(target);
		if (url.protocol !== "zuse:" && url.protocol !== "zuse-dev:") return null;
		if (
			(url.hostname === "computers" &&
				(url.pathname === "" || url.pathname === "/")) ||
			(url.hostname === "" &&
				(url.pathname === "/" || url.pathname === "/computers"))
		)
			return "/";
	} catch {
		/* Ignore malformed external payloads. */
	}
	return null;
};
