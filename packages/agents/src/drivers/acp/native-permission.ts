import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";
import type { ToolCategory } from "../../kernel/permission-policy.ts";
import {
	getBashPolicy,
	getFsPolicy,
	getToolPolicy,
} from "../../kernel/policy.ts";

export type AcpNativePermissionContext = {
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const lower = (value: string): string => value.toLowerCase();

const ACP_NATIVE_PERMISSION_METHODS = new Set([
	"permission/request",
	"session/request_permission",
	"tool/requestapproval",
	"tool/canusetool",
]);

export const isAcpNativePermissionMethod = (method: string): boolean =>
	ACP_NATIVE_PERMISSION_METHODS.has(lower(method));

const firstStringByKey = (
	value: unknown,
	keys: ReadonlySet<string>,
	depth = 0,
): string | null => {
	if (depth > 5) return null;
	if (typeof value === "string") return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstStringByKey(item, keys, depth + 1);
			if (found !== null) return found;
		}
		return null;
	}
	const record = asRecord(value);
	if (record === null) return null;
	for (const [key, item] of Object.entries(record)) {
		if (keys.has(lower(key)) && typeof item === "string" && item.length > 0) {
			return item;
		}
	}
	for (const item of Object.values(record)) {
		const found = firstStringByKey(item, keys, depth + 1);
		if (found !== null) return found;
	}
	return null;
};

const stringifyCompact = (value: unknown, max = 220): string => {
	const raw =
		typeof value === "string"
			? value
			: (() => {
					try {
						return JSON.stringify(value);
					} catch {
						return String(value);
					}
				})();
	return raw.length > max ? `${raw.slice(0, max - 1)}...` : raw;
};

const COMMAND_KEYS = new Set([
	"command",
	"cmd",
	"shellcommand",
	"shell_command",
	"displaycommand",
	"display_command",
]);
const PATH_KEYS = new Set([
	"path",
	"filepath",
	"file_path",
	"targetpath",
	"target_path",
	"destination",
	"newpath",
	"new_path",
]);
const URL_KEYS = new Set(["url", "uri", "href", "target"]);
const TOOL_KEYS = new Set([
	"tool",
	"toolname",
	"tool_name",
	"name",
	"kind",
	"title",
]);
const SUMMARY_KEYS = new Set([
	"reason",
	"summary",
	"description",
	"prompt",
	"message",
	"question",
]);

type ClassifiedAcpPermission = {
	readonly kind: PermissionKind;
	readonly category: ToolCategory;
	readonly path?: string;
};

const classifyAcpNativePermission = (
	method: string,
	params: unknown,
): ClassifiedAcpPermission => {
	const command = firstStringByKey(params, COMMAND_KEYS);
	const path = firstStringByKey(params, PATH_KEYS);
	const url = firstStringByKey(params, URL_KEYS);
	const tool = firstStringByKey(params, TOOL_KEYS) ?? method;
	const toolKey = lower(tool);
	const toolTokens = new Set(
		tool
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length > 0),
	);

	if (
		command !== null ||
		toolKey.includes("shell") ||
		toolKey.includes("bash") ||
		toolKey.includes("terminal")
	) {
		return {
			kind: { _tag: "Bash", command: command ?? tool },
			category: "execute",
		};
	}
	const mutates = [
		"create",
		"delete",
		"edit",
		"move",
		"patch",
		"post",
		"put",
		"replace",
		"upload",
		"write",
	].some((verb) => toolTokens.has(verb));
	if (mutates) {
		return {
			kind: { _tag: "FileWrite", path: path ?? url ?? tool },
			category: "edit",
		};
	}
	const reads = [
		"fetch",
		"find",
		"get",
		"glob",
		"grep",
		"inspect",
		"list",
		"read",
		"search",
		"stat",
		"view",
		"web",
	].some((verb) => toolTokens.has(verb));
	if (reads) {
		return {
			kind:
				url !== null
					? { _tag: "Network", url }
					: {
							_tag: "Other",
							tool,
							summary: path ?? stringifyCompact(params),
						},
			category: "read",
			...(path !== null ? { path } : {}),
		};
	}
	if (path !== null) {
		return { kind: { _tag: "FileWrite", path }, category: "edit" };
	}

	return {
		kind: {
			_tag: "Other",
			tool,
			summary:
				firstStringByKey(params, SUMMARY_KEYS) ?? stringifyCompact(params),
		},
		category: "other",
	};
};

const nativePermissionPolicy = (
	permission: ClassifiedAcpPermission,
	runtimeMode: RuntimeMode,
	permissionMode: PermissionMode,
):
	| { readonly kind: "auto-allow" }
	| { readonly kind: "auto-deny" }
	| { readonly kind: "prompt"; readonly forcePrompt: boolean } => {
	const { kind } = permission;
	switch (kind._tag) {
		case "Bash":
			return getBashPolicy(kind.command, runtimeMode, permissionMode);
		case "FileWrite":
			return getFsPolicy("write", kind.path, runtimeMode, permissionMode);
		case "Network":
		case "Other":
			if (permission.category === "read" && permission.path !== undefined) {
				return getFsPolicy(
					"read",
					permission.path,
					runtimeMode,
					permissionMode,
				);
			}
			return getToolPolicy(permission.category, runtimeMode, permissionMode);
	}
};

const nativePermissionResponse = (allowed: boolean): Record<string, unknown> =>
	allowed
		? {
				outcome: "approved",
				decision: "approved",
				approved: true,
				allow: true,
				allowed: true,
			}
		: {
				outcome: "denied",
				decision: "denied",
				approved: false,
				allow: false,
				allowed: false,
			};

const standardAcpPermissionResponse = (
	params: unknown,
	decision: "allow-once" | "allow-always" | "deny",
): Record<string, unknown> => {
	const record = asRecord(params);
	const options = Array.isArray(record?.options) ? record.options : [];
	const preferredKinds =
		decision === "allow-always"
			? ["allow_always", "allow_once"]
			: decision === "allow-once"
				? ["allow_once", "allow_always"]
				: ["reject_once", "reject_always"];
	for (const preferredKind of preferredKinds) {
		const selected = options.find((option) => {
			const candidate = asRecord(option);
			return candidate?.kind === preferredKind;
		});
		const selectedRecord = asRecord(selected);
		const optionId = selectedRecord?.optionId ?? selectedRecord?.option_id;
		if (typeof optionId === "string") {
			return { outcome: { outcome: "selected", optionId } };
		}
	}
	return { outcome: { outcome: "cancelled" } };
};

export const handleAcpNativePermissionRequest = async (
	method: string,
	params: unknown,
	ctx: AcpNativePermissionContext,
): Promise<unknown | null> => {
	if (!isAcpNativePermissionMethod(method)) return null;

	const permission = classifyAcpNativePermission(method, params);
	const policy = nativePermissionPolicy(
		permission,
		ctx.getRuntimeMode(),
		ctx.getPermissionMode(),
	);
	const isStandardAcp = lower(method) === "session/request_permission";
	if (policy.kind === "auto-allow")
		return isStandardAcp
			? standardAcpPermissionResponse(params, "allow-once")
			: nativePermissionResponse(true);
	if (policy.kind === "auto-deny")
		return isStandardAcp
			? standardAcpPermissionResponse(params, "deny")
			: nativePermissionResponse(false);

	const decision = await ctx.requestPermission(permission.kind, {
		forcePrompt: policy.forcePrompt,
	});
	if (isStandardAcp) {
		return standardAcpPermissionResponse(
			params,
			decision._tag === "Deny"
				? "deny"
				: decision._tag === "AllowForSession" || decision._tag === "AlwaysAllow"
					? "allow-always"
					: "allow-once",
		);
	}
	return nativePermissionResponse(decision._tag !== "Deny");
};
