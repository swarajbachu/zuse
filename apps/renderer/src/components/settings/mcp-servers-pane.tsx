import "@zuse/i18n/english/settings";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	McpServerDescriptor,
	McpServerSource,
	McpServerStatus,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Alert02Icon,
	Key01Icon,
	Loading02Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
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
		get title() {
			return uiMessage("settings:mcp_servers_pane_built_in");
		},
		get description() {
			return uiMessage(
				"settings:mcp_servers_pane_zuse_s_own_tool_servers_injected_into_every_session_always_on",
			);
		},
		sources: ["builtin"],
	},
	{
		get title() {
			return uiMessage("settings:mcp_servers_pane_claude_code_2");
		},
		get description() {
			return uiMessage(
				"settings:mcp_servers_pane_configured_servers_installed_plugins_and_connected_apps_available",
			);
		},
		sources: [
			"claude-user",
			"claude-project",
			"claude-local",
			"claude-plugin",
			"claude-app",
		],
	},
	{
		get title() {
			return uiMessage("settings:mcp_servers_pane_codex");
		},
		get description() {
			return uiMessage(
				"settings:mcp_servers_pane_configured_and_provider_managed_mcp_servers_available_to_codex_se",
			);
		},
		sources: ["codex"],
	},
	{
		get title() {
			return uiMessage("settings:mcp_servers_pane_provider_apps");
		},
		get description() {
			return uiMessage(
				"settings:mcp_servers_pane_apps_and_connectors_reported_by_the_provider_connected_tools_are",
			);
		},
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	if (status === undefined || status.state === "connecting") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
				<HugeiconsIcon
					icon={Loading02Icon}
					className="size-3 animate-spin motion-reduce:animate-none"
					aria-hidden
				/>
				{uiMessage("settings:mcp_servers_pane_checking")}
			</span>
		);
	}
	if (status.state === "connected") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-emerald-500">
				<HugeiconsIcon icon={Tick02Icon} className="size-3" aria-hidden />
				{status.toolCount ?? 0}{" "}
				{status.toolCount === 1
					? uiMessage("settings:mcp_servers_pane_tool")
					: uiMessage("settings:mcp_servers_pane_tools")}
			</span>
		);
	}
	if (status.state === "needs-auth") {
		return (
			<span className="flex items-center gap-1 text-[11px] text-amber-400">
				<HugeiconsIcon icon={Key01Icon} className="size-3" aria-hidden />
				{uiMessage("settings:mcp_servers_pane_auth_required")}
			</span>
		);
	}
	if (status.state === "error") {
		return (
			<span
				className="flex max-w-56 items-center gap-1 truncate text-[11px] text-red-400"
				title={status.error ?? uiMessage("settings:mcp_servers_pane_error")}
			>
				<HugeiconsIcon
					icon={Alert02Icon}
					className="size-3 shrink-0"
					aria-hidden
				/>
				<span className="truncate">
					{status.error ?? uiMessage("settings:mcp_servers_pane_error")}
				</span>
			</span>
		);
	}
	return (
		<span className="text-[11px] text-muted-foreground">
			{uiMessage("settings:mcp_servers_pane_off")}
		</span>
	);
}

function ServerSettingsRow({
	server,
	status,
}: {
	server: McpServerDescriptor;
	status: McpServerStatus | undefined;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
						{authenticating
							? uiMessage("settings:mcp_servers_pane_waiting")
							: uiMessage("common:connect")}
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
					<span className="text-[11px] text-muted-foreground">
						{uiMessage("settings:mcp_servers_pane_read_only")}
					</span>
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
								? uiMessage("settings:mcp_servers_pane_command_not_found", {
										value1: String(req.detail),
									})
								: uiMessage("settings:mcp_servers_pane_is_not_set", {
										value1: String(req.detail),
									})}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
					{uiMessage("settings:mcp_servers_pane_refresh_all")}
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
								{uiMessage("settings:mcp_servers_pane_no_servers_configured")}
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
				title={uiMessage("settings:mcp_servers_pane_adding_servers")}
				description={uiMessage(
					"settings:mcp_servers_pane_zuse_combines_your_agents_native_mcp_configs_with_servers_plugins_and",
				)}
			>
				<div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
					<p>
						<RichMessage
							id="settings:mcp_servers_pane_claude_code_claude_mcp_add_or_edit_mcp_json_claude_json_sentence"
							components={{
								part0: <code className="font-mono text-[12px]" />,
								part1: <code className="font-mono text-[12px]" />,
								part2: <code className="font-mono text-[12px]" />,
							}}
							values={{
								code0: "claude mcp add …",
								code1: ".mcp.json",
								code2: "~/.claude.json",
							}}
						/>
					</p>
					<p>
						<RichMessage
							id="settings:mcp_servers_pane_codex_add_a_mcp_servers_lt_name_gt_block_to_codex_config_tom_sentence"
							components={{
								part0: <code className="font-mono text-[12px]" />,
								part1: <code className="font-mono text-[12px]" />,
							}}
							values={{
								code0: "[mcp_servers.<name>]",
								code1: "~/.codex/config.toml",
							}}
						/>
					</p>
				</div>
			</SettingsFrame>
		</div>
	);
}
