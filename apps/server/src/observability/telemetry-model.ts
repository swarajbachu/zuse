import type { DiagnosticEvent } from "@zuse/contracts";
import { Cause, Exit } from "effect";

import {
	diagnosticFingerprint,
	sanitizeDiagnosticText,
	sanitizeDiagnosticValue,
} from "../diagnostics/diagnostics-model.ts";

const correlationAttribute = (
	attributes: ReadonlyMap<string, unknown>,
	keys: ReadonlyArray<string>,
): string | null => {
	for (const key of keys) {
		const value = attributes.get(key);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
};

const ALLOWED_ATTRIBUTE_KEYS = new Set([
	"project.id",
	"projectId",
	"chat.id",
	"chatId",
	"session.id",
	"sessionId",
	"provider.id",
	"providerId",
	"provider.model",
	"rpc.method",
	"rpc.service",
	"error.type",
	"error.tag",
	"operation",
	"subsystem",
	"process.type",
	"process.pid",
]);

export const filterTelemetryAttributes = (
	attributes: ReadonlyMap<string, unknown> | Record<string, unknown>,
): Record<string, unknown> => {
	const entries =
		attributes instanceof Map
			? [...attributes.entries()]
			: Object.entries(attributes);
	return Object.fromEntries(
		entries
			.filter(([key]) => ALLOWED_ATTRIBUTE_KEYS.has(key))
			.map(([key, value]) => [key, sanitizeDiagnosticValue(value)]),
	);
};

export const telemetryCategoryForSpan = (name: string): string => {
	const normalized = name.toLowerCase();
	if (normalized.startsWith("rpcserver.")) {
		const method = normalized.slice("rpcserver.".length);
		if (method.startsWith("provider.")) return "provider";
		if (method.startsWith("git.") || method.startsWith("worktree."))
			return "git";
		if (method.startsWith("pty.") || method.startsWith("terminal.")) {
			return "terminal";
		}
		if (
			method.startsWith("api.") ||
			method.startsWith("pairing.") ||
			method.startsWith("network.")
		) {
			return "network";
		}
		if (method.startsWith("diagnostics.")) return "diagnostics";
		if (method.startsWith("auth.")) return "auth";
		if (method.startsWith("permission.")) return "permission";
		if (method.startsWith("attachment.")) return "attachment";
		if (method.startsWith("mcp.")) return "mcp";
		if (
			method.startsWith("session.") ||
			method.startsWith("chat.") ||
			method.startsWith("workspace.")
		) {
			return "persistence";
		}
		return "rpc";
	}
	if (normalized.startsWith("rpc.")) {
		return "rpc";
	}
	if (normalized.startsWith("provider.")) return "provider";
	if (normalized.startsWith("git.")) return "git";
	if (normalized.startsWith("pty.") || normalized.startsWith("terminal.")) {
		return "terminal";
	}
	if (normalized.startsWith("sql.") || normalized.startsWith("persistence.")) {
		return "persistence";
	}
	if (normalized.startsWith("api.") || normalized.startsWith("network.")) {
		return "network";
	}
	if (normalized.startsWith("diagnostics.")) return "diagnostics";
	return "server";
};

export interface CompletedTelemetrySpan {
	readonly name: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly startTime: bigint;
	readonly endTime: bigint;
	readonly exit: Exit.Exit<unknown, unknown>;
	readonly attributes: ReadonlyMap<string, unknown>;
	readonly runId: string;
}

const safeErrorType = (value: unknown): string => {
	if (
		typeof value === "object" &&
		value !== null &&
		"_tag" in value &&
		typeof value._tag === "string" &&
		/^[A-Za-z][A-Za-z0-9]*$/.test(value._tag)
	) {
		return value._tag;
	}
	if (value instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(value.name)) {
		return value.name;
	}
	return "UnknownError";
};

export const telemetryCauseSummary = (
	cause: Cause.Cause<unknown>,
): {
	readonly kind: "failure" | "defect" | "interrupted";
	readonly type: string;
	readonly stackFrames?: string;
} => {
	if (Cause.hasInterruptsOnly(cause)) {
		return { kind: "interrupted", type: "Interrupted" };
	}
	const value = Cause.squash(cause);
	const stackFrames =
		value instanceof Error
			? sanitizeDiagnosticText(
					value.stack?.split(/\r?\n/).slice(1, 21).join("\n") ?? "",
				).trim()
			: "";
	return {
		kind: Cause.hasDies(cause) ? "defect" : "failure",
		type: safeErrorType(value),
		...(stackFrames.length === 0 ? {} : { stackFrames }),
	};
};

export const telemetryEventFromSpan = (
	span: CompletedTelemetrySpan,
): DiagnosticEvent => {
	const category = telemetryCategoryForSpan(span.name);
	const failed = Exit.isFailure(span.exit);
	const interrupted = failed && Cause.hasInterruptsOnly(span.exit.cause);
	const severity = interrupted ? "warn" : failed ? "error" : "info";
	const attributes = filterTelemetryAttributes(span.attributes);
	const cause = failed ? telemetryCauseSummary(span.exit.cause) : null;
	const detail =
		Object.keys(attributes).length > 0 || cause !== null
			? JSON.stringify(
					{
						...(cause === null ? {} : { cause }),
						...(Object.keys(attributes).length === 0 ? {} : { attributes }),
					},
					null,
					2,
				)
			: undefined;
	const durationMs =
		Number(span.endTime > span.startTime ? span.endTime - span.startTime : 0n) /
		1_000_000;
	const message = sanitizeDiagnosticText(span.name);
	const source = `server.${category}`;

	return {
		id: `span_${span.traceId}_${span.spanId}`,
		createdAt: new Date(Number(span.endTime / 1_000_000n)).toISOString(),
		severity,
		source,
		category,
		message,
		...(detail === undefined ? {} : { detail }),
		fingerprint: diagnosticFingerprint({ source, category, message }),
		runId: span.runId,
		recoveryStatus: failed && !interrupted ? "unresolved" : "not-needed",
		traceId: span.traceId,
		spanId: span.spanId,
		projectId: correlationAttribute(span.attributes, [
			"project.id",
			"projectId",
		]),
		chatId: correlationAttribute(span.attributes, ["chat.id", "chatId"]),
		sessionId: correlationAttribute(span.attributes, [
			"session.id",
			"sessionId",
		]),
		providerId: correlationAttribute(span.attributes, [
			"provider.id",
			"providerId",
		]),
		durationMs,
	};
};
