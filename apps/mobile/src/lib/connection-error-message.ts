export const connectionErrorMessage = (cause: unknown): string => {
	const text = cause instanceof Error ? cause.message : String(cause);
	if (text.includes("RelayEnvironmentList")) {
		return "Relay returned an older computer list. Refresh after the relay finishes updating.";
	}
	if (text.startsWith("relay_list_")) {
		return "Could not load your computers from the relay.";
	}
	if (text.startsWith("relay_status_")) {
		if (text.includes("invalid_dpop_proof")) {
			return "Could not verify this phone with the relay. Restart the app and try again.";
		}
		if (text.includes("invalid_workos_token")) {
			return "Your sign-in expired. Sign out, sign in again, and refresh computers.";
		}
		return "Could not check computer presence.";
	}
	if (text.startsWith("relay_dpop_token_")) {
		if (text.includes("invalid_dpop_proof")) {
			return "Could not verify this phone with the relay. Restart the app and try again.";
		}
		if (text.includes("invalid_workos_token")) {
			return "Your sign-in expired. Sign out, sign in again, and refresh computers.";
		}
		if (
			text.startsWith("relay_dpop_token_5") ||
			text.startsWith("relay_dpop_token_429")
		) {
			return "Relay is temporarily unavailable. Try again in a moment.";
		}
		return "Could not authorize this phone with the relay.";
	}
	if (text.startsWith("relay_connect_")) {
		if (
			text.startsWith("relay_connect_5") ||
			text.startsWith("relay_connect_429")
		) {
			return "Relay is temporarily unavailable. Try again in a moment.";
		}
		return "Could not connect to that computer.";
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
