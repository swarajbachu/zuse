import type { AcpRpcError } from "@zuse/acp/rpc-client";

export interface FormatAcpErrorOptions {
	readonly fallback: string;
	readonly diagnostics?: string;
	readonly appendDiagnostics?: boolean;
	readonly rawEnvelope?: string;
}

const structuredDetail = (data: object): string | null => {
	const record = data as Record<string, unknown>;
	for (const key of ["message", "error", "details", "reason"] as const) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	try {
		const serialized = JSON.stringify(data);
		return serialized !== "{}" && serialized.length > 0 ? serialized : null;
	} catch {
		return null;
	}
};

export const formatAcpError = (
	error: AcpRpcError,
	options: FormatAcpErrorOptions,
): string => {
	const parts: string[] = [];
	if (typeof error.message === "string" && error.message.length > 0) {
		parts.push(error.message);
	}
	if (typeof error.data === "string" && error.data.length > 0) {
		parts.push(error.data);
	} else if (error.data !== null && typeof error.data === "object") {
		const detail = structuredDetail(error.data);
		if (detail !== null) parts.push(detail);
	}

	const diagnostics = options.diagnostics?.trim() ?? "";
	if (parts.length === 0) {
		parts.push(diagnostics.length > 0 ? diagnostics : options.fallback);
	} else if (
		options.appendDiagnostics === true &&
		diagnostics.length > 0 &&
		!parts.includes(diagnostics)
	) {
		parts.push(`Diagnostics:\n${diagnostics}`);
	}
	if (typeof error.code === "number") parts.push(`(code ${error.code})`);
	if (options.rawEnvelope !== undefined && options.rawEnvelope.length > 0) {
		parts.push(`Raw JSON-RPC error:\n${options.rawEnvelope}`);
	}
	return parts.join(" — ");
};
