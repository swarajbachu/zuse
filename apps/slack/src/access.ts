import type { Installation } from "./installations.ts";
import type { AppEnv } from "./types.ts";

/** One policy decision shared by task admission, pickers and queued execution. */
export const executionAccount = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
) => {
	const mode = installation.credentials.accessMode ?? "installer";
	if (mode === "installer" && userId !== installation.ownerId) return null;
	const ownerId = mode === "shared" ? installation.ownerId : userId;
	const profile = await env.store.member(installation, ownerId);
	return profile.connection
		? { ownerId, profile, connection: profile.connection }
		: null;
};

export const policyOptions = [
	{
		value: "personal",
		text: {
			type: "plain_text",
			text: "Each person connects their own account",
		},
	},
	{
		value: "installer",
		text: { type: "plain_text", text: "Only me, using my connected account" },
	},
	{
		value: "shared",
		text: { type: "plain_text", text: "Whole team uses my connected account" },
	},
];
