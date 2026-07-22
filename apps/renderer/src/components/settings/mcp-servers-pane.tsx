import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert02Icon,
	Key01Icon,
	Loading02Icon,
	Tick02Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	McpServerDescriptor,
	McpServerSource,
	McpServerStatus,
} from "@zuse/contracts";
import { RefreshCw as RefreshIcon } from "lucide-react";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { useMcpStore } from "../../store/mcp.ts";
import { SettingsFrame, SettingsGroup } from "../settings-page.tsx";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch";

const SOURCE_GROUPS: ReadonlyArray<{
	readonly title: string;
	readonly description: string;
	readonly sources: ReadonlyArray<McpServerSource>;
}> = [
	{
		title: "Built-in",
		description:
			"Zuse's own tool servers, injected into every session. Always on.",
		sources: ["builtin"],
	},
	{
		title: "Claude Code",
		description:
			"Configured servers, installed plugins, and connected apps available to Claude sessions.",
		sources: [
			"claude-user",
			"claude-project",
			"claude-local",
			"claude-plugin",
			"claude-app",
		],
	},
	{
		title: "Codex",
		description:
			"Configured and provider-managed MCP servers available to Codex sessions. Config-backed toggles apply to Codex everywhere.",
		sources: ["codex"],
	},
	{
		title: "Provider apps",
		description:
			"Apps and connectors reported by the provider. Connected tools are grouped under the aggregate apps server.",
		sources: ["codex-app"],
	},
];

const SOURCE_LABEL: Record<McpServerSource, string> = {
	"claude-user": "user",
	"claude-project": "project",
	"claude-local": "project (local)",
	"claude-plugin": "plugin",
	"claude-app": "connected app",
	codex: "codex",
	"codex-app": "provider app",
	builtin: "built-in",
};

function StatusBadge({ status }: { status: McpServerStatus | undefined }) {
	if (status === undefined || status.state === "connecting") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
				<HugeiconsIcon
					icon={Loading02Icon}
					className="size-3 animate-spin motion-reduce:animate-none"
					aria-hidden
				/>
				checking
			</span>
		);
	}
	if (status.state === "connected") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-emerald-500">
				<HugeiconsIcon icon={Tick02Icon} className="size-3" aria-hidden />
				{status.toolCount ?? 0} {status.toolCount === 1 ? "tool" : "tools"}
			</span>
		);
	}
	if (status.state === "needs-auth") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-amber-400">
				<HugeiconsIcon icon={Key01Icon} className="size-3" aria-hidden />
				auth required
			</span>
		);
	}
	if (status.state === "error") {
		return (
			<span
				className="flex max-w-56 items-center gap-1 truncate text-[11px] text-red-400"
				title={status.error ?? "error"}
			>
				<HugeiconsIcon
					icon={Alert02Icon}
					className="size-3 shrink-0"
					aria-hidden
				/>
				<span className="truncate">{status.error ?? "error"}</span>
			</span>
		);
	}
	return <span className="text-[11px] text-muted-foreground">off</span>;
}

function ServerSettingsRow({
	server,
	status,
}: {
	server: McpServerDescriptor;
	status: McpServerStatus | undefined;
}) {
	const setEnabled = useMcpStore((s) => s.setEnabled);
	const authenticate = useMcpStore((s) => s.authenticate);
	const authenticating = useMcpStore((s) => s.authenticating.has(server.key));
	const detail =
		server.transport === null
			? server.kind === "app-group"
				? "Aggregate provider app server"
				: "Managed by the provider"
			: server.transport === "stdio"
				? [server.command, ...server.args].filter(Boolean).join(" ")
				: (server.url ?? "");
	const enabled = server.enabledInConfig && !server.disabledByZuse;
	const unmet = (status?.requirements ?? []).filter((req) => !req.satisfied);

	return (
		<div
			className={cn(
				"flex flex-col gap-1 px-4 py-3",
				server.parentKey !== null && "pl-8",
			)}
		>
			<div className="flex items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-medium text-foreground">
							{server.name}
						</span>
						<span className="text-[11px] text-muted-foreground">
							{SOURCE_LABEL[server.source]}
						</span>
					</div>
					<p
						className="truncate font-mono text-[11px] text-muted-foreground"
						title={detail}
					>
						{detail}
					</p>
				</div>
				<StatusBadge status={status} />
				{status?.state === "needs-auth" &&
				server.authenticationAction !== null ? (
					<Button
						size="sm"
						variant="outline"
						disabled={authenticating}
						onClick={() => void authenticate(server.key)}
					>
						{authenticating ? "Waiting…" : "Connect"}
					</Button>
				) : null}
				{server.toggleSupported ? (
					<Switch
						checked={enabled}
						disabled={!server.enabledInConfig && server.source !== "codex-app"}
						aria-label={`${enabled ? "Disable" : "Enable"} ${server.name}`}
						onCheckedChange={(next) => void setEnabled(server.key, next)}
					/>
				) : (
					<span className="text-[11px] text-muted-foreground">read-only</span>
				)}
			</div>
			{unmet.length > 0 && status?.state !== "needs-auth" ? (
				<ul className="flex flex-col gap-0.5">
					{unmet.map((req) => (
						<li
							key={`${req.kind}:${req.detail}`}
							className="text-[11px] text-amber-400/90"
						>
							{req.kind === "command"
								? `command not found: ${req.detail}`
								: `${req.detail} is not set`}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * Settings → MCP Servers. Read-through view of the user's native MCP
 * configs (Zuse keeps no registry of its own): every server Claude Code
 * and Codex are configured with, its live status and requirements, an
 * enable/disable toggle, and OAuth sign-in for servers that need it.
 * Adding or editing servers happens in the native config files.
 */
export function McpServersPane() {
	const servers = useMcpStore((s) => s.servers);
	const statuses = useMcpStore((s) => s.statuses);
	const refreshing = useMcpStore((s) => s.refreshing);
	const load = useMcpStore((s) => s.load);
	const refresh = useMcpStore((s) => s.refresh);

	useEffect(() => {
		void load({});
	}, [load]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-end">
				<Button
					size="sm"
					variant="outline"
					disabled={refreshing}
					onClick={() => void refresh({})}
				>
					<RefreshIcon
						className={cn(
							"size-3.5",
							refreshing && "animate-spin motion-reduce:animate-none",
						)}
					/>
					Refresh all
				</Button>
			</div>
			{SOURCE_GROUPS.map((group) => {
				const groupServers = servers.filter((server) =>
					group.sources.includes(server.source),
				);
				if (groupServers.length === 0 && group.sources[0] !== "builtin") {
					return (
						<SettingsFrame
							key={group.title}
							title={group.title}
							description={group.description}
						>
							<p className="text-[13px] text-muted-foreground">
								No servers configured.
							</p>
						</SettingsFrame>
					);
				}
				return (
					<SettingsGroup
						key={group.title}
						title={group.title}
						description={group.description}
					>
						{groupServers.map((server) => (
							<ServerSettingsRow
								key={server.key}
								server={server}
								status={statuses.get(server.key)}
							/>
						))}
					</SettingsGroup>
				);
			})}
			<SettingsFrame
				title="Adding servers"
				description="Zuse combines your agents' native MCP configs with servers, plugins, and connectors reported by the provider."
			>
				<div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
					<p>
						Claude Code:{" "}
						<code className="font-mono text-[12px]">claude mcp add …</code> or
						edit <code className="font-mono text-[12px]">.mcp.json</code> /{" "}
						<code className="font-mono text-[12px]">~/.claude.json</code>
					</p>
					<p>
						Codex: add a{" "}
						<code className="font-mono text-[12px]">
							[mcp_servers.&lt;name&gt;]
						</code>{" "}
						block to{" "}
						<code className="font-mono text-[12px]">~/.codex/config.toml</code>
					</p>
				</div>
			</SettingsFrame>
		</div>
	);
}
