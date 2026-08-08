import { formatError } from "../../../lib/format-error.ts";
import { toastManager } from "../../ui/toast.tsx";

export const messageForError = (cause: unknown): string => {
	const formatted = formatError(cause);
	if (formatted.includes("not_signed_in")) {
		return "Sign in before setting up remote access.";
	}
	if (formatted.includes("cloudflared_not_found")) {
		return "Zuse Serve’s secure connection component is missing. Reinstall or update Zuse, then try again.";
	}
	if (formatted.includes("no_pairing_endpoint")) {
		return "Enable browser and device access before creating a connection link.";
	}
	if (formatted.includes("no_advertised_host")) {
		return "Connect both devices to the same network, then try again.";
	}
	if (
		formatted.includes("Failed to fetch") ||
		formatted.includes("NetworkError") ||
		formatted.includes("relay_50")
	) {
		return "The network service could not be reached. Check your connection and try again.";
	}
	return formatted || "Something went wrong. Try again.";
};

export const showError = (title: string, cause: unknown): void => {
	toastManager.add({
		type: "error",
		title,
		description: messageForError(cause),
	});
};
