import "@zuse/i18n/english/extensions";
import type {
	AgentPlugin,
	AgentPluginCatalog,
	AgentPluginCommand,
	AgentPluginDetails,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { agentPluginActions } from "../../lib/agent-plugin-client.ts";
import { errorMessage } from "../../lib/error-message.ts";
import { rendererPlatformCapabilities } from "../../lib/platform-capabilities.ts";
import { getLocalEnvironmentId } from "../../lib/rpc-client.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { Button } from "../ui/button.tsx";

export function AgentPluginsPane() {
	const { message: t } = useMessages(["extensions"]);
	const environment = useEnvironmentCatalogStore((s) => s.activeEnvironmentId);
	if (
		!rendererPlatformCapabilities().desktop ||
		environment !== getLocalEnvironmentId()
	)
		return (
			<p className="text-xs text-muted-foreground">
				{t("extensions:plugins_local")}
			</p>
		);
	return <LocalPlugins />;
}
function LocalPlugins() {
	const { message: t } = useMessages(["extensions"]);
	const [catalog, setCatalog] = useState<AgentPluginCatalog | null>(null);
	const [query, setQuery] = useState("");
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [selection, setSelection] = useState<{
		plugin: AgentPlugin;
		details: AgentPluginDetails;
	} | null>(null);
	const generation = useRef(0);
	const perform = async (work: () => Promise<void>) => {
		const version = ++generation.current;
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (cause) {
			if (version === generation.current)
				setError(errorMessage(cause, t("extensions:plugins_failed")));
		} finally {
			if (version === generation.current) setBusy(false);
		}
	};
	const refresh = async () => {
		const version = generation.current;
		const next = await agentPluginActions.catalog();
		if (version === generation.current) setCatalog(next);
	};
	useEffect(() => {
		void perform(refresh);
		return () => {
			generation.current++;
		};
	}, []);
	const execute = (command: AgentPluginCommand) =>
		perform(async () => {
			const version = generation.current;
			const result = await agentPluginActions.execute(command);
			if (version !== generation.current) return;
			setNotice(result.message);
			setSelection(null);
			setSource("");
			await refresh();
		});
	const inspect = (plugin: AgentPlugin) =>
		perform(async () => {
			const version = generation.current;
			const details = await agentPluginActions.inspect(plugin);
			if (version === generation.current) setSelection({ plugin, details });
		});
	const visible =
		catalog?.plugins.filter((p) =>
			`${p.displayName} ${p.description} ${p.marketplace}`
				.toLowerCase()
				.includes(query.toLowerCase()),
		) ?? [];
	return (
		<div className="space-y-5">
			<div className="flex items-center gap-2">
				<input
					aria-label={t("extensions:plugins_search")}
					placeholder={t("extensions:plugins_search")}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="h-7 min-w-0 flex-1 rounded-md bg-muted/45 px-2.5 text-xs"
				/>
				<Button
					className="h-7"
					variant="ghost"
					size="sm"
					disabled={busy}
					onClick={() => void perform(refresh)}
				>
					{t("extensions:plugins_refresh")}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("extensions:plugins_native")}
			</p>
			{busy ? (
				<p role="status" className="text-xs text-muted-foreground">
					{t("extensions:plugins_working")}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			) : null}
			{notice ? (
				<p role="status" className="text-xs text-muted-foreground">
					{notice}
				</p>
			) : null}
			{catalog?.errors.map((error, i) => (
				<p
					key={`${i}:${error}`}
					role="alert"
					className="text-xs text-destructive"
				>
					{error}
				</p>
			))}
			<div className="space-y-3">
				{visible.map((plugin) => (
					<div
						key={`${plugin.marketplace}:${plugin.id}`}
						className="flex items-center gap-3 rounded-md bg-muted/20 px-3 py-2"
					>
						<div className="min-w-0 flex-1">
							<p className="text-xs font-medium">{plugin.displayName}</p>
							<p className="truncate text-[11px] text-muted-foreground">
								{plugin.marketplace} · {plugin.description}
							</p>
							<p className="text-[11px] text-muted-foreground">
								{!plugin.available
									? t("extensions:plugins_unavailable")
									: plugin.installed
										? plugin.enabled
											? t("extensions:plugins_enabled")
											: t("extensions:plugins_disabled")
										: t("extensions:plugins_not_installed")}
							</p>
						</div>
						<Button
							className="h-7"
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => void inspect(plugin)}
						>
							{t("extensions:plugins_details")}
						</Button>
						{plugin.installed ? (
							<>
								<Button
									className="h-7"
									size="sm"
									variant="ghost"
									disabled={busy || (!plugin.enabled && !plugin.available)}
									onClick={() =>
										void execute({
											_tag: "set-enabled",
											plugin,
											enabled: !plugin.enabled,
										})
									}
								>
									{plugin.enabled
										? t("extensions:plugins_disable")
										: t("extensions:plugins_enable")}
								</Button>
								<Button
									className="h-7"
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												t("extensions:plugins_remove_confirm", {
													name: plugin.displayName,
												}),
											)
										)
											void execute({ _tag: "uninstall", plugin });
									}}
								>
									{t("extensions:plugins_remove")}
								</Button>
							</>
						) : null}
					</div>
				))}
			</div>
			{!busy && catalog && !visible.length ? (
				<p className="text-xs text-muted-foreground">
					{t("extensions:plugins_empty")}
				</p>
			) : null}
			{selection ? (
				<section className="space-y-2 rounded-md bg-muted/30 p-3">
					<h3 className="text-sm font-medium">
						{selection.plugin.displayName}
					</h3>
					<p className="whitespace-pre-wrap text-xs text-muted-foreground">
						{selection.details.description}
					</p>
					{[
						["Skills", selection.details.skills],
						["Hooks", selection.details.hooks],
						["MCP", selection.details.mcpServers],
						["Apps", selection.details.apps],
					].map(([label, items]) => (
						<p key={String(label)} className="break-words text-xs">
							<span className="font-medium">{label}: </span>
							{Array.isArray(items) && items.length ? items.join(", ") : "—"}
						</p>
					))}
					<p className="text-xs text-muted-foreground">
						{t("extensions:plugins_trust")}
					</p>
					<div className="flex gap-2">
						{!selection.plugin.installed ? (
							<Button
								className="h-7"
								size="sm"
								disabled={
									busy ||
									!selection.plugin.available ||
									!selection.plugin.installable
								}
								onClick={() => {
									if (
										window.confirm(
											t("extensions:plugins_install_confirm", {
												name: selection.plugin.displayName,
											}),
										)
									)
										void execute({ _tag: "install", plugin: selection.plugin });
								}}
							>
								{t("extensions:plugins_install")}
							</Button>
						) : null}
						<Button
							className="h-7"
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => setSelection(null)}
						>
							{t("extensions:plugins_close")}
						</Button>
					</div>
				</section>
			) : null}
			<details className="text-xs">
				<summary className="cursor-pointer text-muted-foreground">
					{t("extensions:plugins_marketplaces")}
				</summary>
				<div className="mt-3 space-y-3">
					<p className="text-xs text-muted-foreground">
						{t("extensions:plugins_source_help")}
					</p>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (source.trim())
								void execute({
									_tag: "add-marketplace",
									source: source.trim(),
								});
						}}
					>
						<input
							className="h-7 min-w-0 flex-1 rounded-md bg-muted/45 px-2.5 text-xs"
							aria-label={t("extensions:plugins_source")}
							placeholder={t("extensions:plugins_source")}
							value={source}
							onChange={(e) => setSource(e.target.value)}
							disabled={busy}
						/>
						<Button className="h-7" size="sm" disabled={busy || !source.trim()}>
							{t("extensions:plugins_add")}
						</Button>
					</form>
					{catalog?.marketplaces.map((m) => (
						<div key={m.name} className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate">{m.name}</span>
							<Button
								className="h-7"
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									void execute({
										_tag: "update-marketplace",
										marketplace: m.name,
									})
								}
							>
								{t("extensions:plugins_update")}
							</Button>
							<Button
								className="h-7"
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() => {
									if (
										window.confirm(
											t("extensions:plugins_remove_confirm", { name: m.name }),
										)
									)
										void execute({
											_tag: "remove-marketplace",
											marketplace: m.name,
										});
								}}
							>
								{t("extensions:plugins_remove")}
							</Button>
						</div>
					))}
				</div>
			</details>
		</div>
	);
}
