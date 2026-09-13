import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import {
	diagnosticFingerprint,
	sanitizeDiagnosticText,
} from "../diagnostics/diagnostics-model.ts";
import type { TelemetryStore } from "../observability/telemetry-store.ts";

type DiagnosticFields = Record<string, unknown>;

const SAFE_FIELD_KEYS = new Set([
	"environmentId",
	"exitCode",
	"hasConnectorToken",
	"hasLabel",
	"heartbeatActive",
	"lanPolicy",
	"lanPort",
	"managedTunnel",
]);

const structuralReason = (value: unknown): string => {
	const candidate =
		value instanceof Error
			? value.name
			: typeof value === "object" &&
					value !== null &&
					"_tag" in value &&
					typeof value._tag === "string"
				? value._tag
				: typeof value === "string"
					? (value.split(/[\s:]/u, 1)[0] ?? "")
					: typeof value;
	return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(candidate)
		? candidate
		: "UnknownError";
};

const safeFields = (fields: DiagnosticFields): DiagnosticFields => {
	const safe = Object.fromEntries(
		Object.entries(fields).filter(
			([key, value]) =>
				SAFE_FIELD_KEYS.has(key) &&
				(typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean" ||
					value === null),
		),
	);
	if ("reason" in fields || "error" in fields) {
		safe.reasonType = structuralReason(fields.reason ?? fields.error);
	}
	return safe;
};

export const appendApiDiagnostic = (
	store: TelemetryStore["Service"],
	event: string,
	fields: DiagnosticFields = {},
): Effect.Effect<void> =>
	Effect.sync(() => {
		const message = sanitizeDiagnosticText(`api.${event}`);
		const source = event.startsWith("cloudflared.")
			? "server.managed-tunnel"
			: "server.api";
		const exitCode =
			typeof fields.exitCode === "number" ? fields.exitCode : undefined;
		const failed =
			event.endsWith(".fail") ||
			event.endsWith(".error") ||
			(event.endsWith(".exited") && exitCode !== undefined && exitCode !== 0);
		const detailFields = safeFields(fields);
		store.record({
			id: `api_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
			createdAt: new Date().toISOString(),
			severity: failed ? "error" : "info",
			source,
			category: "network",
			message,
			...(Object.keys(detailFields).length === 0
				? {}
				: { detail: JSON.stringify(detailFields) }),
			fingerprint: diagnosticFingerprint({
				source,
				category: "network",
				message,
			}),
			runId: store.runId,
			recoveryStatus: failed ? "unresolved" : "not-needed",
		});
	});
