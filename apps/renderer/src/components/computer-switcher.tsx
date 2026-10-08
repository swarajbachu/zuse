import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	environmentRoute,
	parseEnvironmentRoute,
} from "@zuse/client-runtime/environment-scope";
import {
	type ApiEnvironmentRecord,
	type CommandId,
	ENVIRONMENT_PRESENCE_STALE_MS,
	EnvironmentId,
	HOSTED_APP_URL,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ComputerIcon } from "@zuse/icons/solid-rounded";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import {
	AddComputerDialogHost,
	openAddComputerDialog,
} from "./add-computer-dialog.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

export function ComputerSwitcher() {
	return window.zuse?.ssh === undefined &&
		window.zuse?.tailnet === undefined ? (
		<HostedComputerSwitcher />
	) : (
		<DesktopComputerSwitcher />
	);
}

function DesktopComputerSwitcher() {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const initialize = useEnvironmentCatalogStore((state) => state.initialize);

	useEffect(() => {
		void initialize().catch((cause) =>
			console.error("[zuse] environment catalog initialize failed", cause),
		);
	}, [initialize]);

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-label={uiMessage("chat:computer_switcher_add_computer")}
							className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => openAddComputerDialog()}
						>
							<Plus aria-hidden="true" className="size-3.5" />
						</button>
					}
				/>
				<TooltipPopup>
					{uiMessage("chat:computer_switcher_add_computer")}
				</TooltipPopup>
			</Tooltip>
			<AddComputerDialogHost />
		</>
	);
}

const routeEnvironmentId = (): string | null => {
	return parseEnvironmentRoute(window.location.pathname)?.environmentId ?? null;
};

const relativeTime = (timestamp: number | undefined): string => {
	if (timestamp === undefined) return "Never seen";
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
	if (seconds < 60) return "Just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
};

const openEnvironment = (environmentId: string): void => {
	const url = `${HOSTED_APP_URL}${environmentRoute(environmentId)}`;
	if (window.location.origin === HOSTED_APP_URL) {
		window.location.assign(url);
		return;
	}
	const bridge = window.zuse?.app;
	if (bridge !== undefined) {
		bridge.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

function HostedComputerSwitcher() {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const [environments, setEnvironments] = useState<
		ReadonlyArray<ApiEnvironmentRecord>
	>([]);
	const [localEnvironmentId, setLocalEnvironmentId] = useState<string | null>(
		null,
	);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const refresh = async (): Promise<void> => {
			try {
				const environmentId = EnvironmentId.make(
					useEnvironmentCatalogStore.getState().activeEnvironmentId,
				);
				const [status, catalog] = await Promise.all([
					dispatchEnvironmentShellCommand<
						Record<never, never>,
						{ environmentId?: string }
					>({
						environmentId,
						kind: "api.status",
						commandId: crypto.randomUUID() as CommandId,
						payload: {},
					}).then(({ result }) => result),
					dispatchEnvironmentShellCommand<
						Record<never, never>,
						{ environments: ReadonlyArray<ApiEnvironmentRecord> }
					>({
						environmentId,
						kind: "api.environments",
						commandId: crypto.randomUUID() as CommandId,
						payload: {},
					}).then(({ result }) => result),
				]);
				if (!cancelled) {
					setLocalEnvironmentId(status.environmentId ?? null);
					setEnvironments(catalog.environments);
					setFailed(false);
				}
			} catch {
				if (!cancelled) setFailed(true);
			}
		};
		void refresh();
		const timer = window.setInterval(refresh, 30_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);
	const selectedId = routeEnvironmentId() ?? localEnvironmentId;
	const selected = useMemo(
		() =>
			environments.find(
				(environment) => environment.environmentId === selectedId,
			) ?? null,
		[environments, selectedId, uiMessage],
	);

	if (failed && environments.length === 0) return null;

	return (
		<div className="border-b border-sidebar-border/40 px-2 py-2">
			<Menu>
				<MenuTrigger
					aria-label={uiMessage("chat:computer_switcher_switch_computer")}
					className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
				>
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
						<HugeiconsIcon icon={ComputerIcon} className="size-4" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs font-medium">
							{selected?.label ??
								uiMessage("chat:computer_switcher_this_computer")}
						</span>
						<span className="block truncate text-[10px] text-muted-foreground">
							{selected === null
								? uiMessage("chat:computer_switcher_local_workspace")
								: selected.lastHeartbeat !== undefined &&
										Date.now() - selected.lastHeartbeat <=
											ENVIRONMENT_PRESENCE_STALE_MS
									? uiMessage("chat:computer_switcher_online")
									: uiMessage("chat:computer_switcher_offline", {
											value1: String(relativeTime(selected.lastHeartbeat)),
										})}
						</span>
					</span>
					<ChevronDown
						aria-hidden="true"
						className="size-3.5 text-muted-foreground"
					/>
				</MenuTrigger>
				<MenuPopup
					align="start"
					className="w-[min(22rem,calc(100vw-1rem))]"
					side="bottom"
				>
					<div className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
						{uiMessage("chat:computer_switcher_computers")}
					</div>
					{environments.map((environment) => {
						const online =
							environment.lastHeartbeat !== undefined &&
							Date.now() - environment.lastHeartbeat <=
								ENVIRONMENT_PRESENCE_STALE_MS;
						const active = environment.environmentId === selectedId;
						return (
							<MenuItem
								key={environment.environmentId}
								className="min-h-11 items-start py-2"
								onClick={() =>
									active
										? undefined
										: openEnvironment(environment.environmentId)
								}
							>
								<span
									aria-hidden="true"
									className={`mt-1.5 size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2">
										<span className="truncate font-medium">
											{environment.label ??
												uiMessage("chat:computer_switcher_unnamed_computer")}
										</span>
										{active ? (
											<span className="text-[10px] text-muted-foreground">
												{uiMessage("chat:computer_switcher_current")}
											</span>
										) : null}
									</span>
									<span className="block truncate text-[11px] text-muted-foreground">
										{online
											? uiMessage("chat:computer_switcher_online")
											: relativeTime(environment.lastHeartbeat)}
										{environment.runtimeVersion
											? ` · v${environment.runtimeVersion}`
											: ""}
									</span>
								</span>
							</MenuItem>
						);
					})}
					{environments.length === 0 ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">
							{uiMessage(
								"chat:computer_switcher_no_served_computers_are_linked_to_this_account_yet",
							)}
						</div>
					) : null}
				</MenuPopup>
			</Menu>
		</div>
	);
}
