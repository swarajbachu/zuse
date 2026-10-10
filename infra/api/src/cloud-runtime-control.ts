/** The runtime may orchestrate work, but never administer accounts or credentials. */
export const runtimeControlPathAllowed = (
	path: string,
	method: string,
): boolean => {
	if (
		!path.startsWith("/v1/cloud/") ||
		path.includes("%") ||
		path.includes("\\") ||
		path.includes("#")
	)
		return false;
	const url = new URL(path, "https://runtime.invalid");
	if (url.pathname !== path.split("?")[0]) return false;
	if ([...url.searchParams.keys()].some((key) => key !== "projectId"))
		return false;
	if (method === "GET")
		return /^\/v1\/cloud\/(providers|projects|workspaces(?:\/[^/]+)?)$/u.test(
			url.pathname,
		);
	if (url.search) return false;
	if (method === "POST")
		return /^\/v1\/cloud\/workspaces(?:\/fork|\/[^/]+\/(?:pause|resume|restart|update|archive|unarchive|delete|preview-url|gateway\/ticket))?$/u.test(
			path,
		);
	return (
		method === "DELETE" &&
		/^\/v1\/cloud\/workspaces\/[^/]+\/preview-url$/u.test(path)
	);
};
