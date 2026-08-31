export const connectionErrorMessage = (cause: unknown): string => {
	const text = cause instanceof Error ? cause.message : String(cause);
	if (text.includes("ApiEnvironmentList")) {
		return "API returned an older computer list. Refresh after the api finishes updating.";
	}
	if (text.startsWith("api_list_")) {
		return "Could not load your computers from the api.";
	}
	if (text.startsWith("api_status_")) {
		if (text.includes("invalid_dpop_proof")) {
			return "Could not verify this phone with the api. Restart the app and try again.";
		}
		if (text.includes("invalid_workos_token")) {
			return "Your sign-in expired. Sign out, sign in again, and refresh computers.";
		}
		return "Could not check computer presence.";
	}
	if (text.startsWith("api_dpop_token_")) {
		if (text.includes("invalid_dpop_proof")) {
			return "Could not verify this phone with the api. Restart the app and try again.";
		}
		if (text.includes("invalid_workos_token")) {
			return "Your sign-in expired. Sign out, sign in again, and refresh computers.";
		}
		if (
			text.startsWith("api_dpop_token_5") ||
			text.startsWith("api_dpop_token_429")
		) {
			return "API is temporarily unavailable. Try again in a moment.";
		}
		return "Could not authorize this phone with the api.";
	}
	if (text.startsWith("api_connect_")) {
		if (
			text.startsWith("api_connect_5") ||
			text.startsWith("api_connect_429")
		) {
			return "API is temporarily unavailable. Try again in a moment.";
		}
		return "Could not connect to that computer.";
	}
	if (
		text.includes("fetch failed") ||
		text.includes("Could not connect to the server")
	) {
		return "Your computer is unreachable. Messages will stay queued.";
	}
	if (
		text.includes("SocketOpenError") ||
		text.includes('timeout waiting for "open"')
	) {
		return "Could not reach this computer. Check that it is online and retry.";
	}
	if (text.includes("SocketCloseError")) {
		return "The connection to this computer ended. Reconnecting may fix it.";
	}
	return text;
};
