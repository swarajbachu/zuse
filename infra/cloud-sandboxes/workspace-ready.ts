const workspaceId = process.env.ZUSE_CLOUD_WORKSPACE_ID?.trim();
const relayUrl = process.env.ZUSE_RELAY_URL?.replace(/\/+$/u, "");
const tokenFile = process.env.ZUSE_ENROLLMENT_TOKEN_FILE?.trim();

if (!workspaceId || !relayUrl || !tokenFile) {
	throw new Error("workspace_readiness_configuration_missing");
}

const token = (await Bun.file(tokenFile).text()).trim();
const response = await fetch(
	`${relayUrl}/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/ready`,
	{
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	},
);
if (!response.ok) {
	const body = (await response.json().catch(() => ({}))) as { error?: unknown };
	throw new Error(
		typeof body.error === "string"
			? body.error
			: `workspace_readiness_${response.status}`,
	);
}
