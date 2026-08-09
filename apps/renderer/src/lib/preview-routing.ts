import { PreviewOpError } from "@zuse/contracts";

export type PreviewUiError = {
	readonly message: string;
	readonly approvalUrl: string | null;
};

const PREVIEW_ERROR_MESSAGES: Record<string, string> = {
	"invalid-port": "That port cannot be opened as a preview.",
	"server-not-found": "The server stopped. Start it again, then refresh.",
	"server-not-http": "That listener is not an HTTP development server.",
	"private-network-required":
		"Turn on Private networking in Cloud Space, then retry.",
	"private-network-permission-required":
		"Preview sharing needs one-time network permission on the cloud machine.",
	"private-preview-approval-required":
		"Approve private HTTPS for this network, then retry.",
	"preview-unavailable": "The private preview could not be opened.",
};

const safeApprovalUrl = (value: string | undefined): string | null => {
	if (value === undefined) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			url.hostname === "login.tailscale.com" &&
			(url.pathname === "/f/serve" ||
				url.pathname.startsWith("/admin/feature/"))
			? url.toString()
			: null;
	} catch {
		return null;
	}
};

export const previewErrorDetails = (error: unknown): PreviewUiError => {
	const code = error instanceof PreviewOpError ? error.code : null;
	return {
		message:
			(code === null ? undefined : PREVIEW_ERROR_MESSAGES[code]) ??
			"The private preview could not be opened.",
		approvalUrl:
			error instanceof PreviewOpError
				? safeApprovalUrl(error.approvalUrl)
				: null,
	};
};

export const localPreviewUrl = (port: number): string =>
	`http://localhost:${port}`;
