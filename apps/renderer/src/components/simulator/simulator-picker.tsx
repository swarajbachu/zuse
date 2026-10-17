import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { SimulatorState, SimulatorSummary } from "@zuse/contracts";
import {
	Refresh01Icon,
	Settings01Icon,
	SmartPhone02Icon,
} from "@zuse/icons/solid-rounded";
import { useSimulatorActions } from "~/lib/simulator-client-bus.ts";
import { groupSimulators } from "~/lib/simulator-view.ts";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui.ts";
import {
	DOCK_HOVER_REVEAL_CLASS,
	DOCK_LABEL_CLASS,
	DOCK_META_CLASS,
} from "../dock-panel/text.ts";
import { Button } from "../ui/button.tsx";
import { CompactEmptyState } from "../ui/compact-empty-state.tsx";
import { Spinner } from "../ui/spinner.tsx";
import {
	openSimulatorSettings,
	SimulatorError,
	SimulatorIconAction,
} from "./simulator-parts.tsx";

export function SimulatorPicker({
	refTarget,
	panelRef,
	panelId,
	state,
	reopening,
}: {
	refTarget: ChatRef;
	panelRef: ChatRef;
	panelId: string;
	state: SimulatorState;
	/** The tab's simulator session ended elsewhere, e.g. an agent closed it. */
	reopening: boolean;
}) {
	const actions = useSimulatorActions(refTarget.environmentId);
	const groups = groupSimulators(state.devices);
	const open = async (device: SimulatorSummary) => {
		const opened = await actions.run<SimulatorSummary>(
			"simulators.open",
			{ chatId: refTarget.chatId, deviceId: device.id },
			device.id,
		);
		// Android emulators come up under a new id (their serial).
		if (opened)
			useUiStore
				.getState()
				.openDevicePanel(panelRef, opened.result.id, panelId);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-9 shrink-0 items-center gap-1.5 pl-4 pr-2">
				<span className={DOCK_LABEL_CLASS}>Devices</span>
				<span className="tabular-nums text-[11px] text-muted-foreground/70">
					{state.devices.length || null}
				</span>
				<div className="ml-auto flex items-center">
					<SimulatorIconAction
						icon={Refresh01Icon}
						label="Refresh"
						spinning={actions.pending === "refresh"}
						disabled={actions.pending !== null}
						onClick={() =>
							void actions.run("simulators.refresh", {}, "refresh")
						}
					/>
					<SimulatorIconAction
						icon={Settings01Icon}
						label="Simulator settings"
						onClick={openSimulatorSettings}
					/>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
				{reopening ? (
					<p className={cn(DOCK_META_CLASS, "pb-2")}>
						That device’s session ended. Choose one to reopen.
					</p>
				) : null}
				{actions.error ? (
					<div className="pb-2">
						<SimulatorError>{actions.error}</SimulatorError>
					</div>
				) : null}
				{groups.length === 0 ? (
					<div className="flex flex-col items-center gap-2 py-8">
						<CompactEmptyState
							title="No simulators or emulators"
							description="Add one in Xcode or Android Studio, then refresh."
						/>
					</div>
				) : (
					groups.map((group) => (
						<section
							key={`${group.platform}-${group.runtime}`}
							className="pb-2"
						>
							<h3 className="flex h-7 items-center text-[11px] text-muted-foreground/80">
								{group.runtime}
							</h3>
							<ul className="flex flex-col">
								{group.devices.map((device) => (
									<SimulatorRow
										key={device.id}
										device={device}
										state={state}
										chatId={refTarget.chatId}
										pending={actions.pending === device.id}
										disabled={actions.pending !== null}
										onOpen={() => void open(device)}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</div>
			<AgentAccessFooter environmentState={state} refTarget={refTarget} />
		</div>
	);
}

function SimulatorRow({
	device,
	state,
	chatId,
	pending,
	disabled,
	onOpen,
}: {
	device: SimulatorSummary;
	state: SimulatorState;
	chatId: string;
	pending: boolean;
	disabled: boolean;
	onOpen: () => void;
}) {
	const owner = state.sessions.find(
		(session) => session.deviceId === device.id,
	);
	const elsewhere = owner !== undefined && owner.chatId !== chatId;
	const trailing = pending ? (
		<span className="flex items-center gap-1.5 text-muted-foreground">
			<Spinner className="size-3" />
			{device.booted ? "Opening" : "Starting"}
		</span>
	) : elsewhere ? (
		<span className="text-muted-foreground/70">In another chat</span>
	) : (
		<>
			{device.booted ? (
				<span className="flex items-center gap-1.5 text-muted-foreground group-hover:hidden group-focus-visible:hidden">
					<span className="size-1.5 rounded-full bg-success" />
					Running
				</span>
			) : null}
			<span
				className={cn(
					"text-foreground",
					device.booted
						? "hidden group-hover:inline group-focus-visible:inline"
						: DOCK_HOVER_REVEAL_CLASS,
				)}
			>
				{owner ? "Show" : device.booted ? "Open" : "Start"}
			</span>
		</>
	);
	return (
		<li>
			<button
				type="button"
				disabled={disabled || elsewhere}
				onClick={onOpen}
				title={
					elsewhere
						? "Another chat is using this device. Close it there first."
						: undefined
				}
				className="group -mx-2 flex h-8 w-[calc(100%+1rem)] min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
			>
				<HugeiconsIcon
					icon={SmartPhone02Icon}
					className={cn(
						"size-3.5 shrink-0",
						device.booted ? "text-foreground/80" : "text-muted-foreground/70",
					)}
				/>
				<span
					className={cn(
						"min-w-0 flex-1 truncate",
						elsewhere ? "text-muted-foreground" : "text-foreground",
					)}
				>
					{device.name}
				</span>
				<span className="flex shrink-0 items-center text-[11px]">
					{trailing}
				</span>
			</button>
		</li>
	);
}

/** Agent capability sits at the bottom so manual use stays uncluttered. */
function AgentAccessFooter({
	environmentState: state,
	refTarget,
}: {
	environmentState: SimulatorState;
	refTarget: ChatRef;
}) {
	const actions = useSimulatorActions(refTarget.environmentId);
	const enable = () =>
		void actions.run(
			"simulators.configure",
			{ agentAccessEnabled: true },
			"agents",
		);
	let body: React.ReactNode = null;
	if (!state.agentAccessEnabled)
		body = (
			<>
				<span className="min-w-0 flex-1 truncate">
					Agents can’t use devices
				</span>
				<Button
					size="xs"
					variant="outline"
					loading={actions.pending === "agents"}
					onClick={enable}
				>
					Allow
				</Button>
			</>
		);
	else if (state.agentStatus === "installing")
		body = (
			<>
				<Spinner className="size-3" />
				<span className="min-w-0 flex-1 truncate">{state.agentDetail}</span>
			</>
		);
	else if (state.agentStatus === "error")
		body = (
			<>
				<span className="min-w-0 flex-1 truncate text-destructive">
					{state.agentDetail}
				</span>
				<Button
					size="xs"
					variant="outline"
					loading={actions.pending === "agents"}
					onClick={enable}
				>
					Retry
				</Button>
			</>
		);
	if (body === null) return null;
	return (
		<footer className="flex h-10 shrink-0 items-center gap-2 border-t border-border/50 px-4 text-[11px] text-muted-foreground">
			{body}
		</footer>
	);
}
