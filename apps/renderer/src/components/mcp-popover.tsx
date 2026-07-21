import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert02Icon,
	ArrowDown01Icon,
	Key01Icon,
	Loading02Icon,
	PlugSocketIcon,
	RefreshIcon,
	Tick02Icon,
} from "@hugeicons-pro/core-solid-rounded";
import type {
	FolderId,
	McpServerDescriptor,
	McpServerStatus,
	ProviderId,
} from "@zuse/contracts";
import { useEffect, useMemo, useState } from "react";

import {
	MCP_DISPLAY_GROUPS,
	mcpChildrenForParent,
	mcpProviderAvailabilityLabel,
	mcpServersForProvider,
	mcpTopLevelServers,
} from "~/lib/mcp-display.ts";
import { cn } from "~/lib/utils";
import { useMcpStore } from "../store/mcp.ts";
import { useUiStore } from "../store/ui.ts";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

function StateGlyph({
	status,
	available,
}: {
	status: McpServerStatus;
	available: boolean;
}) {
	if (!available) {
		return (
			<span
				aria-hidden
				className="size-1.5 rounded-full bg-muted-foreground/40"
			/>
		);
	}
	if (status.state === "connected") {
		return (
			<HugeiconsIcon
				icon={Tick02Icon}
				className="size-3.5 text-emerald-500"
				aria-hidden
			/>
		);
	}
	if (status.state === "connecting") {
		return (
			<HugeiconsIcon
				icon={Loading02Icon}
				className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
				aria-hidden
			/>
		);
	}
	if (status.state === "needs-auth") {
		return (
			<HugeiconsIcon
				icon={Key01Icon}
				className="size-3.5 text-amber-400"
				aria-hidden
			/>
		);
	}
	if (status.state === "error") {
		return (
			<HugeiconsIcon
				icon={Alert02Icon}
				className="size-3.5 text-red-400"
				aria-hidden
			/>
		);
	}
	return (
		<span
			aria-hidden
			className="size-1.5 rounded-full bg-muted-foreground/40"
		/>
	);
}

const placeholder = (server: McpServerDescriptor): McpServerStatus => ({
	key: server.key,
	name: server.name,
	source: server.source,
	state:
		server.disabledByZuse || !server.enabledInConfig
			? "disabled"
			: "connecting",
	toolCount: null,
	toolNames: [],
	error: null,
	authMethod: null,
	requirements: [],
	checkedAt: 0,
});

function ServerRow({
	server,
	status,
	projectId,
	providerId,
	indented = false,
}: {
	server: McpServerDescriptor;
	status: McpServerStatus;
	projectId: FolderId | undefined;
	providerId: ProviderId;
	indented?: boolean;
}) {
	const authenticate = useMcpStore((state) => state.authenticate);
	const authenticating = useMcpStore((state) =>
		state.authenticating.has(server.key),
	);
	const available = server.availableProviders.includes(providerId);
	const unmet = status.requirements.filter(
		(requirement) => !requirement.satisfied,
	);
	const providerHint = mcpProviderAvailabilityLabel(server);
	const secondary = !available
		? `Available in ${providerHint} sessions`
		: status.state === "error"
			? status.error
			: unmet.length > 0 && status.state !== "needs-auth"
				? unmet
						.map((requirement) => `${requirement.detail} missing`)
						.join(" · ")
				: null;

	return (
		<div
			className={cn("flex flex-col gap-0.5 px-2 py-0.5", indented && "pl-7")}
		>
			<div className="flex min-h-7 items-center gap-2">
				<span className="flex size-4 shrink-0 items-center justify-center">
					<StateGlyph status={status} available={available} />
				</span>
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-[13px]",
						status.state === "disabled" || !available
							? "text-muted-foreground/70"
							: "text-foreground",
					)}
					title={server.name}
				>
					{server.name}
				</span>
				{status.state === "needs-auth" &&
				server.authenticationAction !== null ? (
					<button
						type="button"
						disabled={authenticating}
						onClick={() => void authenticate(server.key, projectId, providerId)}
						className="h-6 shrink-0 rounded-sm border border-border/60 px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
					>
						{authenticating ? "Waiting…" : "Connect"}
					</button>
				) : status.state === "needs-auth" ? (
					<span className="shrink-0 text-[10px] text-amber-500/80">
						Needs auth
					</span>
				) : !available ? (
					<span className="shrink-0 text-[11px] text-muted-foreground">
						{providerHint}
					</span>
				) : status.state === "connecting" ? (
					<span className="shrink-0 text-[10px] text-muted-foreground">
						Checking…
					</span>
				) : status.toolCount !== null ? (
					<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
						{status.toolCount} {status.toolCount === 1 ? "tool" : "tools"}
					</span>
				) : null}
			</div>
			{secondary !== null ? (
				<p
					className="truncate pl-6 text-[11px] leading-snug text-muted-foreground"
					title={secondary}
				>
					{secondary}
				</p>
			) : null}
		</div>
	);
}

function AppGroup({
	server,
	status,
	children,
	statuses,
	projectId,
	providerId,
}: {
	server: McpServerDescriptor;
	status: McpServerStatus;
	children: ReadonlyArray<McpServerDescriptor>;
	statuses: ReadonlyMap<string, McpServerStatus>;
	projectId: FolderId | undefined;
	providerId: ProviderId;
}) {
	const [expanded, setExpanded] = useState(true);
	const available = server.availableProviders.includes(providerId);
	return (
		<div>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((current) => !current)}
				className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-muted/50"
			>
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
						!expanded && "-rotate-90",
					)}
					aria-hidden
				/>
				<span className="flex size-4 shrink-0 items-center justify-center">
					<StateGlyph status={status} available={available} />
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
					{server.name}
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
					{status.toolCount ?? 0} tools · {children.length} apps
				</span>
			</button>
			{mcpChildrenForParent(children, server.key, expanded).map((child) => (
				<ServerRow
					key={child.key}
					server={child}
					status={statuses.get(child.key) ?? placeholder(child)}
					projectId={projectId}
					providerId={providerId}
					indented
				/>
			))}
		</div>
	);
}

export function McpPopover({
	projectId,
	providerId,
}: {
	projectId: FolderId | undefined;
	providerId: ProviderId;
}) {
	const [open, setOpen] = useState(false);
	const servers = useMcpStore((state) => state.servers);
	const statuses = useMcpStore((state) => state.statuses);
	const refreshing = useMcpStore((state) => state.refreshing);
	const load = useMcpStore((state) => state.load);
	const refresh = useMcpStore((state) => state.refresh);
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const scope = useMemo(
		() => ({ projectId, provider: providerId }),
		[projectId, providerId],
	);

	useEffect(() => {
		if (!open) return;
		void load(scope);
	}, [load, open, scope]);

	const providerServers = mcpServersForProvider(servers, providerId);
	const topLevel = mcpTopLevelServers(providerServers);
	const leaves = providerServers.filter(
		(server) => server.kind !== "app-group",
	);
	const connectedCount = leaves.filter(
		(server) => statuses.get(server.key)?.state === "connected",
	).length;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							aria-label="MCP servers"
							className={cn(
								"flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-muted/60",
								open
									? "bg-muted/60 text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<HugeiconsIcon icon={PlugSocketIcon} className="size-3" />
						</PopoverTrigger>
					}
				/>
				<TooltipPopup>MCP servers</TooltipPopup>
			</Tooltip>
			<PopoverPopup
				side="top"
				align="start"
				className="w-80 [&_[data-slot=popover-viewport]]:!overflow-hidden [&_[data-slot=popover-viewport]]:p-px [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:1px]"
			>
				<div className="flex h-8 shrink-0 items-center justify-between border-border/40 border-b px-2">
					<span className="text-[13px] font-medium text-foreground">MCPs</span>
					<button
						type="button"
						aria-label="Refresh MCP server status"
						disabled={refreshing}
						onClick={() => void refresh(scope)}
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
					>
						<HugeiconsIcon
							icon={RefreshIcon}
							className={cn(
								"size-3.5",
								refreshing && "animate-spin motion-reduce:animate-none",
							)}
						/>
					</button>
				</div>
				<div className="max-h-[min(24rem,calc(var(--available-height)-4rem))] overflow-y-auto overscroll-y-contain">
					{topLevel.length === 0 ? (
						<p className="px-2 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
							No MCP servers discovered.
						</p>
					) : (
						MCP_DISPLAY_GROUPS.map((group) => {
							const grouped = topLevel.filter(group.matches);
							if (grouped.length === 0) return null;
							return (
								<section key={group.label} aria-label={group.label}>
									<p className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
										{group.label}
									</p>
									{grouped.map((server) => {
										const status =
											statuses.get(server.key) ?? placeholder(server);
										if (server.kind === "app-group") {
											return (
												<AppGroup
													key={server.key}
													server={server}
													status={status}
													children={providerServers.filter(
														(child) => child.parentKey === server.key,
													)}
													statuses={statuses}
													projectId={projectId}
													providerId={providerId}
												/>
											);
										}
										return (
											<ServerRow
												key={server.key}
												server={server}
												status={status}
												projectId={projectId}
												providerId={providerId}
											/>
										);
									})}
								</section>
							);
						})
					)}
				</div>
				<div className="shrink-0 border-t border-border/40">
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							setView("settings");
							setSettingsSection({ kind: "mcp" });
						}}
						className="flex min-h-8 w-full items-center justify-between rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					>
						<span>Manage MCP servers</span>
						<span className="text-[11px] tabular-nums">
							{connectedCount}/{leaves.length} connected
						</span>
					</button>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
