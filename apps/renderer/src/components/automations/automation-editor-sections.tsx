import { HugeiconsIcon } from "@hugeicons/react";
import {
	type AutomationCapabilities,
	type AutomationConfig,
	FolderId,
} from "@zuse/contracts";
import {
	ArrowDown01Icon,
	Delete02Icon,
	Mail01Icon,
	PlusSignIcon,
} from "@zuse/icons/solid-rounded";
import type {
	AutomationPolicyField,
	AutomationPolicyIssue,
} from "@zuse/utils/automation-policy";
import { type ReactNode, useId, useState } from "react";
import { automationRateWindows } from "~/lib/automation-format.ts";
import { useAutomationMessages } from "~/lib/automation-messages.ts";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui.ts";
import { SlackIcon } from "../icons/slack-icon.tsx";
import { Button } from "../ui/button.tsx";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { Input } from "../ui/input.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import { Switch } from "../ui/switch.tsx";
import {
	AutomationNotice,
	AutomationRow,
	AutomationSelect,
	numberInputClass,
} from "./automation-controls.tsx";

export type MetadataRow = { readonly id: string; key: string; value: string };

export const issuesFor = (
	issues: ReadonlyArray<AutomationPolicyIssue>,
	...fields: ReadonlyArray<AutomationPolicyField>
) => issues.filter((issue) => fields.includes(issue.field));

export function FieldError({ message }: { message?: string | null }) {
	if (!message) return null;
	return (
		<p role="alert" className="text-[11px] text-destructive">
			{message}
		</p>
	);
}

export function PolicyIssues({
	issues,
	action,
}: {
	issues: ReadonlyArray<AutomationPolicyIssue>;
	action?: ReactNode;
}) {
	if (issues.length === 0) return null;
	return (
		<AutomationNotice tone="warning" action={action}>
			{issues.map((issue) => (
				<p key={`${issue.field}-${issue.index ?? ""}-${issue.message}`}>
					{issue.message}
				</p>
			))}
		</AutomationNotice>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-2">
			<p className="text-[11px] font-medium text-muted-foreground">{title}</p>
			{children}
		</div>
	);
}

const Muted = ({ children }: { children: ReactNode }) => (
	<span className="text-[11px] text-muted-foreground">{children}</span>
);

/**
 * Secondary settings in one quiet, collapsed panel. Restrictions the runtime
 * cannot enforce are explained instead of offered.
 */
export function MoreOptions({
	config,
	patch,
	issues,
	capabilities,
	shown,
	spendReason,
	metadata,
	setMetadata,
	folders,
	onLeave,
}: {
	config: AutomationConfig;
	patch: (value: Partial<AutomationConfig>) => void;
	issues: ReadonlyArray<AutomationPolicyIssue>;
	capabilities: AutomationCapabilities | null;
	shown: (key: string) => string | undefined;
	spendReason: string | null;
	metadata: ReadonlyArray<MetadataRow>;
	setMetadata: (update: (rows: MetadataRow[]) => MetadataRow[]) => void;
	folders: ReadonlyArray<{ readonly id: string; readonly name: string }>;
	onLeave: () => void;
}) {
	const automationMessage = useAutomationMessages();

	const id = useId();
	const existingSession = config.action === "existing_session";
	const attention = issuesFor(
		issues,
		"childSessions",
		"network",
		"environment",
		"queue",
		"spendLimit",
		"mcp",
		"notifications",
	);
	const errors = ["metadata", "spendLimit", "rateLimit", "queue"].some((key) =>
		shown(key),
	);
	const notificationErrors = config.notifications.some((_, index) =>
		shown(`notification-${index}`),
	);
	const [open, setOpen] = useState(
		() =>
			attention.length > 0 ||
			config.notifications.length > 0 ||
			config.spendLimitUsd !== null ||
			config.mcpServerIds.length > 0,
	);
	const visible = open || errors || notificationErrors;

	return (
		<Collapsible open={visible} onOpenChange={setOpen}>
			<CollapsibleTrigger className="group flex h-7 items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
				{automationMessage("automations:more_options")}
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className="size-3.5 transition-transform group-data-panel-open:rotate-180"
					aria-hidden
				/>
				{attention.length > 0 && (
					<span
						className="size-1.5 rounded-full bg-warning"
						role="img"
						aria-label={automationMessage(
							"automations:settings_need_attention",
							{ count: attention.length },
						)}
					/>
				)}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="space-y-6 pt-3">
					<Group title={automationMessage("automations:general")}>
						<AutomationRow
							label={automationMessage("automations:project")}
							htmlFor={`${id}-project`}
						>
							<AutomationSelect
								id={`${id}-project`}
								label={automationMessage("automations:project")}
								value={config.projectId}
								options={folders.map((folder) => ({
									value: folder.id,
									label: folder.name,
								}))}
								onChange={(value) =>
									patch({ projectId: FolderId.make(value), sessionId: null })
								}
							/>
						</AutomationRow>
						<Notifications
							config={config}
							patch={patch}
							issues={issues}
							capabilities={capabilities}
							shown={shown}
						/>
					</Group>

					<Connectors
						config={config}
						patch={patch}
						issues={issues}
						onLeave={onLeave}
					/>

					<Group title={automationMessage("automations:limits")}>
						<AutomationRow
							label={automationMessage("automations:spend_limit_per_session")}
							htmlFor={`${id}-spend`}
						>
							{spendReason && config.spendLimitUsd === null ? (
								<Muted>{spendReason}</Muted>
							) : (
								<Input
									id={`${id}-spend`}
									className={cn("h-7 w-28", numberInputClass)}
									type="number"
									min={0}
									step="0.5"
									placeholder={automationMessage("automations:no_limit")}
									aria-invalid={shown("spendLimit") ? true : undefined}
									value={config.spendLimitUsd?.toString() ?? ""}
									onChange={(event) =>
										patch({
											spendLimitUsd: event.target.value
												? Number(event.target.value)
												: null,
										})
									}
								/>
							)}
						</AutomationRow>
						<FieldError message={shown("spendLimit")} />
						<PolicyIssues
							issues={issuesFor(issues, "spendLimit")}
							action={
								<Button
									variant="ghost"
									className="h-7"
									onClick={() => patch({ spendLimitUsd: null })}
								>
									{automationMessage("automations:remove")}
								</Button>
							}
						/>
						<AutomationRow
							label={automationMessage("automations:max_runs")}
							htmlFor={`${id}-rate`}
						>
							<Input
								id={`${id}-rate`}
								className={cn("h-7 w-16", numberInputClass)}
								type="number"
								min={1}
								max={10000}
								aria-invalid={shown("rateLimit") ? true : undefined}
								value={String(config.rateLimit.count)}
								onChange={(event) =>
									patch({
										rateLimit: {
											...config.rateLimit,
											count: Number(event.target.value),
										},
									})
								}
							/>
							<span className="text-muted-foreground">
								{automationMessage("automations:per")}
							</span>
							<AutomationSelect
								label={automationMessage("automations:rate_limit_window")}
								className="w-24"
								value={String(config.rateLimit.windowSeconds)}
								options={[
									...automationRateWindows(),
									...(automationRateWindows().some(
										([seconds]) => seconds === config.rateLimit.windowSeconds,
									)
										? []
										: [
												[
													config.rateLimit.windowSeconds,
													`${config.rateLimit.windowSeconds}s`,
												] as const,
											]),
								].map(([seconds, label]) => ({
									value: String(seconds),
									label,
								}))}
								onChange={(value) =>
									patch({
										rateLimit: {
											...config.rateLimit,
											windowSeconds: Number(value),
										},
									})
								}
							/>
						</AutomationRow>
						<FieldError message={shown("rateLimit")} />
						<AutomationRow
							label={automationMessage("automations:runs_at_once")}
							htmlFor={`${id}-concurrency`}
						>
							<Input
								id={`${id}-concurrency`}
								className={cn("h-7 w-16", numberInputClass)}
								type="number"
								min={1}
								max={20}
								aria-invalid={shown("queue") ? true : undefined}
								value={String(config.queue.maxConcurrency)}
								onChange={(event) =>
									patch({
										queue: {
											...config.queue,
											maxConcurrency: Number(event.target.value),
										},
									})
								}
							/>
						</AutomationRow>
						<FieldError message={shown("queue")} />
						<AutomationRow
							label={automationMessage("automations:queue_events_while_busy")}
							htmlFor={`${id}-queue`}
						>
							<Switch
								id={`${id}-queue`}
								checked={config.queue.enabled}
								onCheckedChange={(enabled) =>
									patch({ queue: { ...config.queue, enabled } })
								}
							/>
						</AutomationRow>
						<PolicyIssues issues={issuesFor(issues, "queue")} />
					</Group>

					<Group title={automationMessage("automations:execution")}>
						<AutomationRow
							label={automationMessage("automations:allow_child_sessions")}
							htmlFor={`${id}-children`}
						>
							<Switch
								id={`${id}-children`}
								checked={config.allowChildSessions}
								disabled={existingSession && config.allowChildSessions}
								onCheckedChange={(allowChildSessions) =>
									patch({ allowChildSessions })
								}
							/>
						</AutomationRow>
						<PolicyIssues issues={issuesFor(issues, "childSessions")} />
						{capabilities?.systemIdentity && (
							<AutomationRow
								label={automationMessage("automations:run_as")}
								htmlFor={`${id}-run-as`}
							>
								<AutomationSelect
									id={`${id}-run-as`}
									label={automationMessage("automations:run_as")}
									value={config.runAs}
									options={[
										{ value: "owner", label: "You" },
										{ value: "system", label: "System user" },
									]}
									onChange={(runAs) => patch({ runAs })}
								/>
							</AutomationRow>
						)}
						{capabilities?.networkIsolation && (
							<AutomationRow
								label={automationMessage("automations:network_access")}
								htmlFor={`${id}-network`}
							>
								<Switch
									id={`${id}-network`}
									checked={config.network.enabled}
									onCheckedChange={(enabled) =>
										patch({ network: { ...config.network, enabled } })
									}
								/>
							</AutomationRow>
						)}
						<PolicyIssues
							issues={issuesFor(issues, "network", "environment")}
							action={
								issuesFor(issues, "network").length > 0 ? (
									<Button
										variant="ghost"
										className="h-7"
										onClick={() =>
											patch({ network: { enabled: true, allowedDomains: [] } })
										}
									>
										{automationMessage("automations:reset")}
									</Button>
								) : undefined
							}
						/>
						<p className="text-[11px] text-muted-foreground">
							{config.cloudMachine
								? automationMessage(
										"automations:each_run_starts_a_new_cloud_agent_as_you",
									)
								: automationMessage(
										config.environment === "cloud"
											? "automations:runs_cloud"
											: "automations:runs_local",
									)}
							{capabilities && !capabilities.networkIsolation
								? " " +
									automationMessage(
										"automations:network_access_isn_t_restricted",
									)
								: ""}
						</p>
					</Group>

					<Group title={automationMessage("automations:metadata")}>
						{metadata.map((row, index) => (
							<div key={row.id} className="flex items-center gap-1.5">
								<Input
									aria-label={automationMessage(
										"automations:metadata_key_value",
										{ value1: index + 1 },
									)}
									className="h-7 w-36 shrink-0"
									placeholder={automationMessage("automations:key")}
									value={row.key}
									onChange={(event) =>
										setMetadata((rows) =>
											rows.map((item) =>
												item.id === row.id
													? { ...item, key: event.target.value }
													: item,
											),
										)
									}
								/>
								<Input
									aria-label={automationMessage(
										"automations:metadata_value_value",
										{ value1: index + 1 },
									)}
									className="h-7 flex-1"
									placeholder={automationMessage("automations:value")}
									value={row.value}
									onChange={(event) =>
										setMetadata((rows) =>
											rows.map((item) =>
												item.id === row.id
													? { ...item, value: event.target.value }
													: item,
											),
										)
									}
								/>
								<Button
									size="icon"
									variant="ghost"
									aria-label={automationMessage(
										"automations:remove_metadata_value",
										{ value1: row.key || index + 1 },
									)}
									onClick={() =>
										setMetadata((rows) =>
											rows.filter((item) => item.id !== row.id),
										)
									}
								>
									<HugeiconsIcon icon={Delete02Icon} aria-hidden />
								</Button>
							</div>
						))}
						<Button
							variant="ghost"
							className="-ms-2 h-7 px-2 text-muted-foreground"
							onClick={() =>
								setMetadata((rows) => [
									...rows,
									{ id: crypto.randomUUID(), key: "", value: "" },
								])
							}
						>
							<HugeiconsIcon icon={PlusSignIcon} aria-hidden />
							{automationMessage("automations:add_metadata")}
						</Button>
						<FieldError message={shown("metadata")} />
					</Group>
				</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}

function Notifications({
	config,
	patch,
	issues,
	capabilities,
	shown,
}: {
	config: AutomationConfig;
	patch: (value: Partial<AutomationConfig>) => void;
	issues: ReadonlyArray<AutomationPolicyIssue>;
	capabilities: AutomationCapabilities | null;
	shown: (key: string) => string | undefined;
}) {
	const automationMessage = useAutomationMessages();

	const add = (channel: "email" | "slack") =>
		patch({
			notifications: [...config.notifications, { channel, destination: "" }],
		});
	return (
		<>
			<AutomationRow
				label={automationMessage("automations:notify_when_a_run_finishes")}
			>
				<Menu>
					<MenuTrigger
						render={
							<Button
								variant="ghost"
								className="-me-2 h-7 px-2 text-muted-foreground"
							/>
						}
					>
						<HugeiconsIcon icon={PlusSignIcon} aria-hidden />
						{automationMessage("automations:add")}
					</MenuTrigger>
					<MenuPopup align="end" className="w-56">
						<MenuItem
							className="items-start gap-2 py-1.5"
							disabled={!capabilities?.emailNotifications}
							onClick={() => add("email")}
						>
							<HugeiconsIcon icon={Mail01Icon} aria-hidden />
							<span>
								<span className="block">
									{automationMessage("automations:email")}
								</span>
								{!capabilities?.emailNotifications && (
									<span className="block text-[11px] text-muted-foreground">
										{automationMessage(
											"automations:email_delivery_isn_t_set_up_on_this_server",
										)}
									</span>
								)}
							</span>
						</MenuItem>
						<MenuItem
							className="items-start gap-2 py-1.5"
							disabled={!capabilities?.slackNotifications}
							onClick={() => add("slack")}
						>
							<SlackIcon />
							<span>
								<span className="block">
									{automationMessage("automations:slack_channel")}
								</span>
								{!capabilities?.slackNotifications && (
									<span className="block text-[11px] text-muted-foreground">
										{automationMessage(
											"automations:cloud_workspaces_with_slack_only",
										)}
									</span>
								)}
							</span>
						</MenuItem>
					</MenuPopup>
				</Menu>
			</AutomationRow>
			{config.notifications.map((notification, index) => {
				const rowIssues = issues.filter(
					(issue) => issue.field === "notifications" && issue.index === index,
				);
				const email = notification.channel === "email";
				return (
					<div key={index} className="space-y-1.5">
						<div className="flex items-center gap-1.5">
							{email ? (
								<HugeiconsIcon
									icon={Mail01Icon}
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							) : (
								<SlackIcon />
							)}
							<Input
								aria-label={
									email
										? automationMessage("automations:email_address_value", {
												value1: index + 1,
											})
										: automationMessage("automations:slack_channel_id_value", {
												value1: index + 1,
											})
								}
								aria-invalid={
									shown(`notification-${index}`) || rowIssues.length > 0
										? true
										: undefined
								}
								className="h-7 flex-1"
								placeholder={
									email
										? automationMessage("automations:name_example_com")
										: automationMessage("automations:slack_channel_id")
								}
								value={notification.destination}
								onChange={(event) =>
									patch({
										notifications: config.notifications.map((item, position) =>
											position === index
												? { ...item, destination: event.target.value }
												: item,
										),
									})
								}
							/>
							<Button
								size="icon"
								variant="ghost"
								aria-label={automationMessage(
									"automations:remove_notification_value",
									{ value1: index + 1 },
								)}
								onClick={() =>
									patch({
										notifications: config.notifications.filter(
											(_, position) => position !== index,
										),
									})
								}
							>
								<HugeiconsIcon icon={Delete02Icon} aria-hidden />
							</Button>
						</div>
						<FieldError message={shown(`notification-${index}`)} />
						<PolicyIssues issues={rowIssues} />
					</div>
				);
			})}
		</>
	);
}

/** Preserve saved native selections for removal without reviving native MCP access. */
function Connectors({
	config,
	patch,
	issues,
	onLeave,
}: {
	config: AutomationConfig;
	patch: (value: Partial<AutomationConfig>) => void;
	issues: ReadonlyArray<AutomationPolicyIssue>;
	onLeave: () => void;
}) {
	const automationMessage = useAutomationMessages();

	return (
		<Group title={automationMessage("automations:mcp_servers")}>
			<Muted>
				{automationMessage(
					"automations:automations_use_this_workspace_s_connected_plugins_selecting_native_mcp_ser",
				)}
			</Muted>
			{config.mcpServerIds.length > 0 && (
				<Muted>
					{automationMessage("automations:previously_selected_mcp", {
						selection: config.mcpServerIds.join(", "),
					})}
				</Muted>
			)}
			<PolicyIssues
				issues={issuesFor(issues, "mcp")}
				action={
					<Button
						variant="ghost"
						className="h-7"
						onClick={() => patch({ mcpServerIds: [] })}
					>
						{automationMessage("automations:clear")}
					</Button>
				}
			/>
			<Button
				variant="ghost"
				className="-ms-2 h-7 px-2 text-muted-foreground"
				onClick={() => {
					useUiStore.getState().setSettingsSection({ kind: "plugins" });
					useUiStore.getState().setView("settings");
					onLeave();
				}}
			>
				{automationMessage("automations:manage_plugins")}
			</Button>
		</Group>
	);
}
