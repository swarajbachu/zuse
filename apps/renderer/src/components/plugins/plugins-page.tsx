import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	PluginAttempt,
	PluginConnection,
	PluginDefinition,
} from "@zuse/contracts";
import { formatDate } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Link04Icon,
	PlusSignIcon,
	RefreshIcon,
	Search01Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import {
	type ReactNode,
	useDeferredValue,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useAuth } from "~/hooks/use-auth.ts";
import {
	hasPluginConnectionLabel,
	usePluginAccount,
	usePluginTenant,
} from "~/lib/connected-plugins.ts";
import {
	openExternal,
	rendererPlatformCapabilities,
} from "~/lib/platform-capabilities.ts";
import {
	pluginRequest,
	pluginReturnTo,
	usePluginSnapshot,
} from "~/lib/plugins-client.ts";
import { useUiStore } from "~/store/ui.ts";
import { Button } from "../ui/button.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { toastManager } from "../ui/toast.tsx";
import { PluginIcon } from "./plugin-icon.tsx";
import { PluginsLoading } from "./plugins-loading.tsx";

type Tab = "browse" | "connected";
const PAGE_SIZE = 40;
const FEATURED_LIMIT = 12;

/** Desktop opens the system browser; the web app hands its own tab over. */
async function openAuthorization(url: string) {
	if (rendererPlatformCapabilities().desktop) await openExternal(url);
	else window.location.assign(url);
}

function usePlugins() {
	const { user, isSignedIn } = useAuth();
	const account = isSignedIn ? (user?.id ?? null) : null;
	const tenant = usePluginTenant();
	const [attempt, setAttempt] = useState<
		(PluginAttempt & { pluginId: string }) | null
	>(null);
	const [busy, setBusy] = useState<string | null>(null);
	// Shared, persisted snapshot: shown instantly, revalidated in the background.
	const { snapshot, failed, refresh } = usePluginSnapshot(account, tenant);
	const load = refresh;

	useEffect(() => {
		setAttempt(null);
	}, [account, tenant]);

	// Resume an attempt started before the page was closed.
	const pendingId = snapshot?.connections.find(
		(connection) => connection.state === "connecting",
	);
	const pendingTenant = snapshot?.tenantId;
	useEffect(() => {
		if (pendingId === undefined || pendingTenant === undefined) return;
		let cancelled = false;
		void pluginRequest({
			action: "poll",
			tenantId: pendingTenant,
			attemptId: pendingId.id,
		})
			.then((status) => {
				if (
					!cancelled &&
					status.kind === "attempt" &&
					status.state === "pending"
				)
					setAttempt(
						(current) => current ?? { ...status, pluginId: pendingId.pluginId },
					);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [pendingId?.id, pendingId?.pluginId, pendingTenant]);

	// The browser hands the ticket to the app, which redeems it; polling only
	// notices that the attempt left `pending` so the row can settle.
	useEffect(() => {
		if (!attempt || !snapshot) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const result = await pluginRequest({
					action: "poll",
					tenantId: snapshot.tenantId,
					attemptId: attempt.id,
				});
				if (stopped) return;
				if (result.kind === "attempt" && result.state !== "pending") {
					setAttempt(null);
					await load();
					return;
				}
			} catch {
				// Transient; keep polling until the attempt expires server-side.
			}
			if (!stopped) timer = setTimeout(poll, 2000);
		};
		timer = setTimeout(poll, 1500);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [attempt, snapshot, load]);

	return {
		snapshot,
		attempt,
		setAttempt,
		busy,
		setBusy,
		failed,
		isSignedIn,
		load,
	};
}

/** Browse plugins and manage the selected workspace’s connections through the shared control plane. */
export function PluginsPage() {
	const tenant = usePluginTenant();
	const account = usePluginAccount();
	return <WorkspacePluginsPage key={`${account}:${tenant}`} />;
}

function WorkspacePluginsPage() {
	const { message: m } = useUiMessages(["plugins"]);
	const { isSignedIn, isLoading } = useAuth();
	// Plugins belong to an account: leave the page on sign-out.
	useEffect(() => {
		if (!isLoading && !isSignedIn)
			useUiStore.getState().setActiveMainTab("chat");
	}, [isLoading, isSignedIn]);
	const state = usePlugins();
	const { snapshot, attempt, busy } = state;
	const [tab, setTab] = useState<Tab>("browse");
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query.trim().toLowerCase());
	const [selected, setSelected] = useState<string | null>(null);
	const [limit, setLimit] = useState(PAGE_SIZE);

	const connectedById = useMemo(() => {
		const map = new Map<string, PluginConnection[]>();
		for (const connection of snapshot?.connections ?? [])
			if (connection.state === "connected")
				map.set(connection.pluginId, [
					...(map.get(connection.pluginId) ?? []),
					connection,
				]);
		return map;
	}, [snapshot]);

	const catalog = snapshot?.catalog ?? [];
	const matches = useMemo(
		() =>
			catalog.filter(
				(plugin) =>
					(tab === "browse" || connectedById.has(plugin.id)) &&
					(deferredQuery.length === 0 ||
						`${plugin.name} ${plugin.description} ${plugin.domain}`
							.toLowerCase()
							.includes(deferredQuery)),
			),
		[catalog, connectedById, deferredQuery, tab],
	);
	useEffect(() => setLimit(PAGE_SIZE), [deferredQuery, tab]);

	/** Validate account names before starting an independent connection attempt. */
	const connect = async (plugin: PluginDefinition, label = plugin.name) => {
		if (!snapshot || busy || attempt) return;
		const trimmedLabel = label.trim() || plugin.name;
		if (
			hasPluginConnectionLabel(snapshot.connections, plugin.id, trimmedLabel)
		) {
			toastManager.add({
				title: m("plugins:plugins_connection_name_exists"),
				type: "error",
			});
			return;
		}
		state.setBusy(plugin.id);
		try {
			const result = await pluginRequest({
				action: "connect",
				tenantId: snapshot.tenantId,
				pluginId: plugin.id,
				label: trimmedLabel,
				requestId: crypto.randomUUID(),
				returnTo: await pluginReturnTo(),
			});
			if (result.kind !== "attempt") throw new Error("Unexpected response");
			if (result.state === "connected")
				toastManager.add({
					title: m("plugins:plugins_connected_toast", { name: plugin.name }),
					description: m("plugins:plugins_connected_toast_detail"),
					type: "success",
				});
			else if (result.state === "pending") {
				state.setAttempt({ ...result, pluginId: plugin.id });
				if (result.authorizationUrl)
					await openAuthorization(result.authorizationUrl);
			} else throw new Error("Connection failed");
			await state.load();
		} catch {
			toastManager.add({
				title: m("plugins:plugins_connect_failed", { name: plugin.name }),
				description: m("plugins:plugins_connect_failed_detail"),
				type: "error",
			});
			await state.load();
		} finally {
			state.setBusy(null);
		}
	};

	const cancel = async () => {
		if (!snapshot || !attempt) return;
		try {
			await pluginRequest({
				action: "cancel",
				tenantId: snapshot.tenantId,
				attemptId: attempt.id,
			});
			state.setAttempt(null);
			await state.load();
		} catch {
			toastManager.add({
				title: m("plugins:plugins_cancel_failed"),
				type: "error",
			});
		}
	};

	const disconnect = async (plugin: PluginDefinition, connectionId: string) => {
		if (!snapshot) return;
		state.setBusy(plugin.id);
		try {
			await pluginRequest({
				action: "disconnect",
				tenantId: snapshot.tenantId,
				connectionId,
			});
			await state.load();
		} catch {
			toastManager.add({
				title: m("plugins:plugins_disconnect_failed", { name: plugin.name }),
				type: "error",
			});
		} finally {
			state.setBusy(null);
		}
	};

	const statusOf = (plugin: PluginDefinition): PluginStatus =>
		attempt?.pluginId === plugin.id || busy === plugin.id
			? "connecting"
			: connectedById.has(plugin.id)
				? "connected"
				: "available";
	const pendingPlugin = attempt
		? catalog.find((plugin) => plugin.id === attempt.pluginId)
		: undefined;
	const detail = selected
		? catalog.find((plugin) => plugin.id === selected)
		: undefined;

	const rowFor = (plugin: PluginDefinition) => (
		<PluginRow
			key={plugin.id}
			plugin={plugin}
			status={statusOf(plugin)}
			locked={
				snapshot?.canManage === false ||
				attempt !== null ||
				(busy !== null && busy !== plugin.id)
			}
			onOpen={() => setSelected(plugin.id)}
			onConnect={() => void connect(plugin)}
		/>
	);

	return (
		<section className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-8 text-xs max-[800px]:px-4">
					{attempt && (
						<PendingBanner
							name={pendingPlugin?.name ?? ""}
							onReopen={
								attempt.authorizationUrl
									? () =>
											attempt.authorizationUrl &&
											void openAuthorization(attempt.authorizationUrl)
									: undefined
							}
							onCancel={() => void cancel()}
						/>
					)}
					{detail ? (
						<PluginDetail
							key={detail.id}
							plugin={detail}
							status={statusOf(detail)}
							connections={connectedById.get(detail.id) ?? []}
							allConnections={snapshot?.connections ?? []}
							locked={
								snapshot?.canManage === false ||
								attempt !== null ||
								busy !== null
							}
							onBack={() => setSelected(null)}
							onConnect={(label) => void connect(detail, label)}
							onDisconnect={(id) => void disconnect(detail, id)}
						/>
					) : (
						<>
							<header className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0">
									<h1 className="text-xl font-medium tracking-[-0.01em] text-foreground">
										{m("plugins:plugins_title")}
									</h1>
									<p className="mt-1 text-muted-foreground">
										{m("plugins:plugins_subtitle")}
									</p>
								</div>
								<div className="flex items-center gap-1.5">
									<label className="flex h-7 w-56 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
										<HugeiconsIcon
											icon={Search01Icon}
											className="size-3.5 shrink-0 text-muted-foreground"
										/>
										<input
											aria-label={m("plugins:plugins_search")}
											placeholder={m("plugins:plugins_search")}
											value={query}
											onChange={(event) => setQuery(event.target.value)}
											className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
										/>
									</label>
									<Button
										variant="ghost"
										size="icon"
										aria-label={m("plugins:plugins_refresh")}
										onClick={() => void state.load()}
									>
										<HugeiconsIcon icon={RefreshIcon} className="size-3.5" />
									</Button>
								</div>
							</header>
							<div className="flex items-center justify-between gap-3">
								<SegmentedTabs<Tab>
									ariaLabel={m("plugins:plugins_title")}
									equalWidth={false}
									value={tab}
									onValueChange={setTab}
									options={[
										{ value: "browse", label: m("plugins:plugins_tab_browse") },
										{
											value: "connected",
											label: (
												<>
													{m("plugins:plugins_tab_connected")}
													{connectedById.size > 0 && (
														<span className="tabular-nums text-muted-foreground">
															{connectedById.size}
														</span>
													)}
												</>
											),
										},
									]}
								/>
							</div>
							{!state.isSignedIn ? (
								<p className="py-8 text-muted-foreground">
									{m("plugins:plugins_sign_in")}
								</p>
							) : state.failed && !snapshot ? (
								<div
									role="alert"
									className="flex items-center gap-3 py-8 text-muted-foreground"
								>
									<p className="flex-1">{m("plugins:plugins_load_failed")}</p>
									<Button
										variant="ghost"
										onClick={() => void state.load()}
										className="shrink-0"
									>
										{m("plugins:plugins_retry")}
									</Button>
								</div>
							) : !snapshot ? (
								<PluginsLoading label={m("plugins:plugins_loading")} />
							) : matches.length === 0 ? (
								<p className="py-12 text-center text-muted-foreground">
									{deferredQuery
										? m("plugins:plugins_no_results", { query: query.trim() })
										: m("plugins:plugins_none_connected")}
								</p>
							) : tab === "browse" && deferredQuery.length === 0 ? (
								<>
									<PluginSection title={m("plugins:plugins_featured")}>
										{matches
											.filter((plugin) => plugin.featured)
											.slice(0, FEATURED_LIMIT)
											.map(rowFor)}
									</PluginSection>
									<PluginSection title={m("plugins:plugins_all")}>
										{matches.slice(0, limit).map(rowFor)}
									</PluginSection>
									{matches.length > limit && (
										<ShowMore
											label={m("plugins:plugins_show_more")}
											onClick={() => setLimit((value) => value + PAGE_SIZE)}
										/>
									)}
								</>
							) : (
								<>
									<PluginSection
										title={
											tab === "connected"
												? m("plugins:plugins_tab_connected")
												: m("plugins:plugins_results")
										}
									>
										{matches.slice(0, limit).map(rowFor)}
									</PluginSection>
									{matches.length > limit && (
										<ShowMore
											label={m("plugins:plugins_show_more")}
											onClick={() => setLimit((value) => value + PAGE_SIZE)}
										/>
									)}
								</>
							)}
						</>
					)}
				</div>
			</div>
		</section>
	);
}

type PluginStatus = "available" | "connecting" | "connected";

function PluginSection({
	title,
	children,
}: {
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-1">
			<h2 className="px-2 pb-1 text-[13px] font-medium text-foreground">
				{title}
			</h2>
			<div className="grid grid-cols-1 gap-x-4 gap-y-0.5 lg:grid-cols-2">
				{children}
			</div>
		</section>
	);
}

function ShowMore({
	label,
	onClick,
}: {
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<Button variant="ghost" className="self-center" onClick={onClick}>
			{label}
		</Button>
	);
}

function PluginRow({
	plugin,
	status,
	locked,
	onOpen,
	onConnect,
}: {
	readonly plugin: PluginDefinition;
	readonly status: PluginStatus;
	readonly locked: boolean;
	readonly onOpen: () => void;
	readonly onConnect: () => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	return (
		<div className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/45">
			<button
				type="button"
				onClick={onOpen}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<PluginIcon name={plugin.name} domain={plugin.domain} />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-medium text-foreground">
						{plugin.name}
					</span>
					<span className="block truncate text-muted-foreground">
						{plugin.description}
					</span>
				</span>
			</button>
			{status === "connecting" ? (
				<span
					role="status"
					aria-label={m("plugins:plugins_connecting_named", {
						name: plugin.name,
					})}
					className="grid size-7 shrink-0 place-items-center text-muted-foreground"
				>
					<Spinner className="size-3.5" />
				</span>
			) : status === "connected" ? (
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0 text-muted-foreground"
					aria-label={m("plugins:plugins_manage_named", { name: plugin.name })}
					onClick={onOpen}
				>
					<HugeiconsIcon icon={Tick02Icon} className="size-4" />
				</Button>
			) : (
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					aria-label={m("plugins:plugins_connect_named", { name: plugin.name })}
					disabled={locked}
					onClick={onConnect}
				>
					<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
				</Button>
			)}
		</div>
	);
}

function PendingBanner({
	name,
	onReopen,
	onCancel,
}: {
	readonly name: string;
	readonly onReopen: (() => void) | undefined;
	readonly onCancel: () => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 py-1.5 pl-3 pr-1.5"
		>
			<Spinner className="size-3.5 text-muted-foreground" />
			<span className="min-w-0 flex-1 text-muted-foreground">
				{m("plugins:plugins_pending", { name })}
			</span>
			{onReopen && (
				<Button variant="ghost" onClick={onReopen}>
					{m("plugins:plugins_reopen")}
				</Button>
			)}
			<Button variant="ghost" onClick={onCancel}>
				{m("plugins:plugins_cancel")}
			</Button>
		</div>
	);
}

/** Show account controls and validate names against every connection for this plugin. */
function PluginDetail({
	plugin,
	status,
	connections,
	allConnections,
	locked,
	onBack,
	onConnect,
	onDisconnect,
}: {
	readonly plugin: PluginDefinition;
	readonly status: PluginStatus;
	readonly connections: readonly PluginConnection[];
	readonly allConnections: readonly PluginConnection[];
	readonly locked: boolean;
	readonly onBack: () => void;
	readonly onConnect: (label: string) => void;
	readonly onDisconnect: (connectionId: string) => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const [label, setLabel] = useState("");
	const duplicateLabel = hasPluginConnectionLabel(
		allConnections,
		plugin.id,
		label,
	);
	return (
		<>
			<nav className="flex items-center gap-1 text-muted-foreground">
				<button
					type="button"
					onClick={onBack}
					className="flex h-7 items-center gap-1 rounded-md hover:text-foreground"
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
					{m("plugins:plugins_back")}
				</button>
				<HugeiconsIcon icon={ArrowRight01Icon} className="size-3" />
				<span className="truncate text-foreground">{plugin.name}</span>
			</nav>
			<header className="flex flex-wrap items-center gap-4">
				<PluginIcon
					name={plugin.name}
					domain={plugin.domain}
					className="size-12 rounded-xl text-base"
				/>
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-xl font-medium tracking-[-0.01em] text-foreground">
						{plugin.name}
					</h1>
					<p className="mt-0.5 truncate text-muted-foreground">
						{plugin.domain}
					</p>
				</div>
				{status === "connecting" ? (
					<Button disabled>
						<Spinner className="size-3.5" />
						{m("plugins:plugins_waiting")}
					</Button>
				) : status === "connected" ? (
					<div className="flex items-center gap-1.5">
						<span className="flex h-7 items-center gap-1 px-2 text-muted-foreground">
							<HugeiconsIcon icon={Tick02Icon} className="size-3.5" />
							{m("plugins:plugins_connected")}
						</span>
					</div>
				) : null}
			</header>
			<p className="max-w-prose text-[13px] leading-5 text-foreground/85">
				{plugin.description}
			</p>
			{connections.length > 0 && (
				<section className="flex flex-col gap-1">
					<h2 className="text-[13px] font-medium">
						{m("plugins:plugins_connections")}
					</h2>
					{connections.map((connection) => (
						<div
							key={connection.id}
							className="flex items-center gap-3 rounded-md py-1"
						>
							<span className="min-w-0 flex-1 truncate">
								{connection.label}
								<span className="ml-2 text-muted-foreground">
									{m("plugins:plugins_connected_on", {
										date: formatDate(connection.createdAt, {
											dateStyle: "medium",
										}),
									})}
								</span>
							</span>
							<Button
								variant="ghost"
								disabled={locked}
								onClick={() => onDisconnect(connection.id)}
							>
								{m("plugins:plugins_disconnect")}
							</Button>
						</div>
					))}
				</section>
			)}
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (
						!locked &&
						status !== "connecting" &&
						label.trim() &&
						!duplicateLabel
					)
						onConnect(label.trim());
				}}
			>
				<input
					className="h-7 w-48 rounded-md bg-muted/55 px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/24"
					aria-label={m("plugins:plugins_connection_name")}
					aria-invalid={duplicateLabel || undefined}
					aria-describedby={
						duplicateLabel ? "plugin-connection-name-error" : undefined
					}
					placeholder={m("plugins:plugins_connection_name_placeholder")}
					maxLength={80}
					value={label}
					onChange={(event) => setLabel(event.target.value)}
					disabled={locked || status === "connecting"}
				/>
				<Button
					className="h-7"
					type="submit"
					disabled={
						locked || status === "connecting" || !label.trim() || duplicateLabel
					}
				>
					<HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
					{m(
						connections.length
							? "plugins:plugins_connect_another"
							: "plugins:plugins_connect",
					)}
				</Button>
				{duplicateLabel && (
					<p
						id="plugin-connection-name-error"
						role="status"
						className="w-full text-xs text-muted-foreground"
					>
						{m("plugins:plugins_connection_name_exists")}
					</p>
				)}
			</form>
			<section className="flex flex-col gap-1">
				<h2 className="text-[13px] font-medium">
					{m("plugins:plugins_information")}
				</h2>
				<dl className="grid grid-cols-[8rem_1fr] gap-y-2 py-1">
					<dt className="text-muted-foreground">
						{m("plugins:plugins_website")}
					</dt>
					<dd>
						<button
							type="button"
							className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
							onClick={() => void openExternal(`https://${plugin.domain}`)}
						>
							{plugin.domain}
							<HugeiconsIcon
								icon={Link04Icon}
								className="size-3 text-muted-foreground"
							/>
						</button>
					</dd>
					{plugin.category && (
						<>
							<dt className="text-muted-foreground">
								{m("plugins:plugins_category")}
							</dt>
							<dd className="capitalize">
								{plugin.category.replaceAll("-", " ")}
							</dd>
						</>
					)}
					<dt className="text-muted-foreground">
						{m("plugins:plugins_access")}
					</dt>
					<dd>{m("plugins:plugins_access_value")}</dd>
				</dl>
			</section>
			<p className="max-w-prose leading-5 text-muted-foreground">
				{m("plugins:plugins_privacy")}
			</p>
		</>
	);
}
