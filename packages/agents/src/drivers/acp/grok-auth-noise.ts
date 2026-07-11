/**
 * Grok's ACP child occasionally prints transient AuthorizationRequired noise
 * on stderr or in session/update error frames even while the session keeps
 * running and the turn completes normally. Treat these as ignorable — surfacing
 * them as provider errors would reject the in-flight prompt, emit an Error
 * event, and flip the session to idle while the agent is still working.
 */
export const isIgnorableGrokAuthNoise = (text: string): boolean => {
	const t = text.toLowerCase();
	return (
		t.includes("authorizationrequired") ||
		t.includes("auth(authorizationrequired)") ||
		(t.includes("grok authentication failed") &&
			t.includes("authorizationrequired")) ||
		(t.includes("worker quit with fatal") && t.includes("auth")) ||
		(t.includes("transport channel closed") && t.includes("auth"))
	);
};
