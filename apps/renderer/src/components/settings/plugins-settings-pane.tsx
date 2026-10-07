import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import type { PluginConnection, PluginSnapshot } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	PlugSocketIcon,
	PuzzleIcon,
	Search01Icon,
} from "@zuse/icons/solid-rounded";
import { useEffect, useMemo, useState } from "react";
import {
	pluginConnectionName,
	usePluginAccount,
} from "~/lib/connected-plugins.ts";
import {
	notifyPluginsChanged,
	pluginRequest,
	usePluginSnapshot,
} from "~/lib/plugins-client.ts";
import { useMcpStore } from "~/store/mcp.ts";
import { type PluginsSettingsTab, useUiStore } from "~/store/ui.ts";
import { PluginIcon } from "../plugins/plugin-icon.tsx";
import { PluginsLoading } from "../plugins/plugins-loading.tsx";
import { Button } from "../ui/button.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { SettingsGroup } from "../ui/settings-panel.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";
import { McpServersPane } from "./mcp-servers-pane.tsx";
import {
	SkillsSettingsList,
	useGlobalSkills,
} from "./skills-settings-list.tsx";

const openPluginsPage = () => {
	const ui = useUiStore.getState();
	ui.setView("chat");
	ui.setActiveMainTab("plugins");
};

/**
 * Settings → Plugins: one place to turn agent capabilities on or off —
 * managed plugins, MCP servers from provider configs, and skills.
 */
export function PluginsSettingsPane({
	initialTab = "plugins",
}: {
	readonly initialTab?: PluginsSettingsTab;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const [tab, setTab] = useState<PluginsSettingsTab>(initialTab);
	const [query, setQuery] = useState("");
	useEffect(() => setTab(initialTab), [initialTab]);
	const plugins = useConnectedPluginRows();
	const mcpCount = useMcpStore((state) => state.servers.length);
	const loadMcp = useMcpStore((state) => state.load);
	useEffect(() => {
		void loadMcp({});
	}, [loadMcp]);
	const skills = useGlobalSkills();

	const count = (value: number | null) =>
		value === null ? null : (
			<span className="tabular-nums text-muted-foreground">{value}</span>
		);

	return (
		<div className="flex flex-col gap-4 text-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<SegmentedTabs<PluginsSettingsTab>
					ariaLabel={m("plugins:plugins_title")}
					equalWidth={false}
					value={tab}
					onValueChange={setTab}
					options={[
						{
							value: "plugins",
							label: (
								<>
									{m("plugins:plugins_settings_tab_plugins")}
									{count(plugins.rows?.length ?? null)}
								</>
							),
						},
						{
							value: "mcps",
							label: (
								<>
									{m("plugins:plugins_settings_tab_mcps")}
									{count(mcpCount)}
								</>
							),
						},
						{
							value: "skills",
							label: (
								<>
									{m("plugins:plugins_settings_tab_skills")}
									{count(skills.skills?.length ?? null)}
								</>
							),
						},
					]}
				/>
				<div className="flex items-center gap-1.5">
					<label className="flex h-7 w-48 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
						<HugeiconsIcon
							icon={Search01Icon}
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<input
							aria-label={m("plugins:plugins_settings_search")}
							placeholder={m("plugins:plugins_settings_search")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</label>
					<Button variant="ghost" onClick={openPluginsPage}>
						{m("plugins:plugins_settings_browse")}
					</Button>
					<Menu>
						<MenuTrigger render={<Button variant="secondary" />}>
							{m("plugins:plugins_settings_add")}
							<HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
						</MenuTrigger>
						<MenuPopup align="end" className="w-52">
							<MenuItem onClick={openPluginsPage}>
								<HugeiconsIcon icon={PuzzleIcon} className="size-3.5" />
								{m("plugins:plugins_settings_add_plugin")}
							</MenuItem>
							<MenuItem onClick={() => setTab("mcps")}>
								<HugeiconsIcon icon={PlugSocketIcon} className="size-3.5" />
								{m("plugins:plugins_settings_add_mcp")}
							</MenuItem>
						</MenuPopup>
					</Menu>
				</div>
			</div>
			{tab === "plugins" ? (
				<ConnectedPluginList state={plugins} query={query} />
			) : tab === "mcps" ? (
				<McpServersPane query={query} />
			) : (
				<SkillsSettingsList state={skills} query={query} />
			)}
		</div>
	);
}

type PluginRow = {
	readonly connection: PluginConnection;
	readonly name: string;
	readonly description: string;
	readonly domain: string;
};

type ConnectedPluginRows = {
	readonly signedIn: boolean;
	readonly tenantId: string | null;
	readonly rows: readonly PluginRow[] | null;
	readonly failed: boolean;
	readonly reload: () => Promise<void>;
};

/** Keep one named settings row per connected account, including disabled accounts. */
function rowsOf(snapshot: PluginSnapshot): readonly PluginRow[] {
	const catalog = new Map(
		snapshot.catalog.map((plugin) => [plugin.id, plugin]),
	);
	return snapshot.connections
		.filter((connection) => connection.state === "connected")
		.map((connection) => {
			const plugin = catalog.get(connection.pluginId);
			return {
				connection,
				name: plugin
					? pluginConnectionName(plugin.name, connection.label)
					: connection.label,
				description: plugin?.description ?? "",
				domain: plugin?.domain ?? "",
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function useConnectedPluginRows(): ConnectedPluginRows {
	const { snapshot, failed, refresh } = usePluginSnapshot(usePluginAccount());
	const account = usePluginAccount();
	const rows = useMemo(
		() => (snapshot === null ? null : rowsOf(snapshot)),
		[snapshot],
	);
	return {
		signedIn: account !== null,
		tenantId: snapshot?.tenantId ?? null,
		rows,
		failed,
		reload: refresh,
	};
}

function ConnectedPluginList({
	state,
	query,
}: {
	readonly state: ConnectedPluginRows;
	readonly query: string;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	// Optimistic switch state until the reload after a toggle lands.
	const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
		new Map(),
	);
	useEffect(() => setOverrides(new Map()), [state.rows]);
	const needle = query.trim().toLowerCase();
	const rows = (state.rows ?? []).filter((row) =>
		`${row.name} ${row.description}`.toLowerCase().includes(needle),
	);

	const toggle = async (row: PluginRow, enabled: boolean) => {
		if (state.tenantId === null) return;
		const id = row.connection.id;
		setPending((current) => new Set(current).add(id));
		setOverrides((current) => new Map(current).set(id, enabled));
		try {
			await pluginRequest({
				action: "setEnabled",
				tenantId: state.tenantId,
				connectionId: id,
				enabled,
			});
			notifyPluginsChanged();
		} catch {
			setOverrides((current) => {
				const next = new Map(current);
				next.delete(id);
				return next;
			});
			toastManager.add({
				title: m("plugins:plugins_settings_toggle_failed", { name: row.name }),
				type: "error",
			});
		} finally {
			setPending((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
		}
	};

	if (!state.signedIn) return <Empty>{m("plugins:plugins_sign_in")}</Empty>;
	if (state.failed && state.rows === null)
		return (
			<Empty>
				{m("plugins:plugins_load_failed")}
				<Button variant="ghost" onClick={() => void state.reload()}>
					{m("plugins:plugins_retry")}
				</Button>
			</Empty>
		);
	if (state.rows === null)
		return <PluginsLoading label={m("plugins:plugins_loading")} />;
	if (rows.length === 0)
		return (
			<Empty>
				{needle
					? m("plugins:plugins_no_results", { query: query.trim() })
					: m("plugins:plugins_none_connected")}
				{!needle && (
					<Button variant="ghost" onClick={openPluginsPage}>
						{m("plugins:plugins_settings_browse")}
					</Button>
				)}
			</Empty>
		);
	return (
		<SettingsGroup title={m("plugins:plugins_tab_connected")}>
			{rows.map((row) => (
				<div
					key={row.connection.id}
					className="flex items-center gap-3 px-3 py-2.5"
				>
					<PluginIcon
						name={row.name}
						domain={row.domain}
						className="size-8 rounded-lg"
					/>
					<div className="min-w-0 flex-1">
						<p className="truncate text-[13px] font-medium text-foreground">
							{row.name}
						</p>
						<p className="truncate text-muted-foreground">{row.description}</p>
					</div>
					<Switch
						checked={overrides.get(row.connection.id) ?? row.connection.enabled}
						disabled={pending.has(row.connection.id)}
						aria-label={row.name}
						onCheckedChange={(next) => void toggle(row, next)}
					/>
				</div>
			))}
		</SettingsGroup>
	);
}

function Empty({ children }: { readonly children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
			{children}
		</div>
	);
}
