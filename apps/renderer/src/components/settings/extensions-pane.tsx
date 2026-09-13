import "@zuse/i18n/english/extensions";
import type {
	ExtensionCapability,
	ExtensionLogEntry,
	ExtensionSource,
	MarketplaceExtension,
} from "@zuse/contracts";
import { useMessages as useExtensionMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";
import {
	extensionActions,
	useExtensionCatalog,
} from "../../lib/extension-client-bus.ts";
import { useExtensionContributions } from "../../lib/extension-registry.tsx";
import { useSettingsStore } from "../../lib/settings-client-bus.ts";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";

const sourceFrom = (value: string, ref: string): ExtensionSource =>
	/^https?:\/\/|^git@/.test(value.trim())
		? {
				_tag: "git",
				url: value.trim(),
				...(ref.trim() ? { ref: ref.trim() } : {}),
			}
		: { _tag: "directory", path: value.trim() };

const approve = (
	extensionMessage: typeof import("@zuse/i18n").message,
	name: string,
	capabilities: ReadonlyArray<ExtensionCapability>,
): boolean =>
	window.confirm(
		extensionMessage("extensions:approve", {
			name,
			capabilities:
				capabilities.join(", ") || extensionMessage("extensions:none"),
		}),
	);

export function ExtensionsPane() {
	const { message: extensionMessage } = useExtensionMessages(["extensions"]);
	const catalog = useExtensionCatalog();
	const contributions = useExtensionContributions();
	const themeSelection = useSettingsStore((state) => state.themeSelection);
	const setThemeSelection = useSettingsStore(
		(state) => state.setThemeSelection,
	);
	const [source, setSource] = useState("");
	const [gitRef, setGitRef] = useState("");
	const [marketplace, setMarketplace] = useState<
		ReadonlyArray<MarketplaceExtension>
	>([]);
	const [logs, setLogs] = useState<ReadonlyArray<ExtensionLogEntry>>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void extensionActions
			.marketplace()
			.then(setMarketplace, (cause) =>
				setError(cause instanceof Error ? cause.message : String(cause)),
			);
	}, []);

	const run = async (key: string, action: () => Promise<unknown>) => {
		setBusy(key);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	const installSource = async () => {
		const nextSource = sourceFrom(source, gitRef);
		const manifest = await extensionActions.inspect(nextSource);
		if (!approve(extensionMessage, manifest.name, manifest.capabilities))
			return;
		await extensionActions.install(nextSource, manifest.capabilities);
		setSource("");
		setGitRef("");
	};

	return (
		<section className="flex flex-col gap-4 text-xs">
			<div className="flex items-center justify-between rounded-md bg-muted/35 px-3 py-2.5">
				<div>
					<p className="font-medium text-foreground">
						{extensionMessage("extensions:preview")}
					</p>
					<p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
						{extensionMessage("extensions:trust")}
					</p>
				</div>
				<Switch
					checked={catalog.globallyEnabled}
					disabled={busy !== null}
					onCheckedChange={(enabled) =>
						void run("global", () => extensionActions.setGlobalEnabled(enabled))
					}
					aria-label={extensionMessage("extensions:preview")}
				/>
			</div>

			<div className="flex flex-col gap-2">
				<p className="font-medium text-foreground">
					{extensionMessage("extensions:source")}
				</p>
				<div className="flex gap-2">
					<input
						className="h-7 min-w-0 flex-1 rounded-md bg-muted/45 px-2.5 text-[11px] outline-none ring-ring focus:ring-1"
						value={source}
						onChange={(event) => setSource(event.target.value)}
						placeholder={extensionMessage("extensions:source_placeholder")}
					/>
					<input
						className="h-7 w-28 rounded-md bg-muted/45 px-2.5 text-[11px] outline-none ring-ring focus:ring-1"
						value={gitRef}
						onChange={(event) => setGitRef(event.target.value)}
						placeholder={extensionMessage("extensions:git_ref")}
					/>
					<Button
						size="sm"
						disabled={!source.trim() || busy !== null}
						onClick={() => void run("install", installSource)}
					>
						{extensionMessage("extensions:inspect")}
					</Button>
				</div>
			</div>

			{error !== null && (
				<p className="rounded-md bg-alert-error-bg px-3 py-2 text-destructive-foreground">
					{error}
				</p>
			)}

			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<p className="font-medium text-foreground">
						{extensionMessage("extensions:installed")}
					</p>
					<span className="text-[10px] text-muted-foreground">
						{extensionMessage("extensions:count", {
							value: catalog.items.length,
						})}
					</span>
				</div>
				{catalog.items.length === 0 ? (
					<p className="rounded-md bg-muted/25 px-3 py-4 text-center text-muted-foreground">
						{extensionMessage("extensions:empty")}
					</p>
				) : (
					catalog.items.map((item) => (
						<div
							key={item.id}
							className="flex items-start gap-3 rounded-md bg-muted/25 px-3 py-2.5"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="truncate font-medium text-foreground">
										{item.manifest.name}
									</p>
									<span className="text-[10px] text-muted-foreground">
										v{item.manifest.version} · {item.status}
									</span>
								</div>
								<p className="mt-0.5 text-[11px] text-muted-foreground">
									{item.manifest.description}
								</p>
								<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/75">
									{item.source._tag === "directory"
										? item.source.path
										: item.source._tag === "git"
											? `${item.source.url}${item.activeCommit ? ` @ ${item.activeCommit.slice(0, 8)}` : ""}`
											: extensionMessage("extensions:market_source", {
													value:
														item.activeCommit?.slice(0, 8) ??
														extensionMessage("extensions:installed"),
												})}
								</p>
								<p className="mt-1 text-[10px] text-muted-foreground">
									{extensionMessage("extensions:capabilities", {
										value:
											item.grantedCapabilities.join(", ") ||
											extensionMessage("extensions:none"),
									})}
								</p>
								{contributions.find(
									(extension) => extension.extensionId === item.id,
								)?.error ? (
									<p role="alert" className="mt-2 text-destructive">
										{extensionMessage("extensions:client")}{" "}
										{
											contributions.find(
												(extension) => extension.extensionId === item.id,
											)?.error
										}
									</p>
								) : null}
								{item.error && (
									<p className="mt-1 text-[10px] text-destructive">
										{item.error}
									</p>
								)}
							</div>
							<div className="flex shrink-0 flex-wrap justify-end gap-1">
								<Button
									size="sm"
									variant="ghost"
									onClick={() =>
										void run(`logs:${item.id}`, async () =>
											setLogs(await extensionActions.logs(item.id)),
										)
									}
								>
									{extensionMessage("extensions:logs")}
								</Button>
								{item.enabled ? (
									<Button
										size="sm"
										variant="ghost"
										disabled={busy !== null}
										onClick={() =>
											void run(`disable:${item.id}`, () =>
												extensionActions.disable(item.id),
											)
										}
									>
										{extensionMessage("extensions:disable")}
									</Button>
								) : (
									<Button
										size="sm"
										variant="ghost"
										disabled={busy !== null}
										onClick={() =>
											void run(`enable:${item.id}`, () =>
												extensionActions.enable(item.id),
											)
										}
									>
										{extensionMessage("extensions:enable")}
									</Button>
								)}
								<Button
									size="sm"
									variant="ghost"
									disabled={busy !== null}
									onClick={() =>
										void run(`reload:${item.id}`, () =>
											item.source._tag === "directory"
												? extensionActions.reload(item.id)
												: extensionActions.update(
														item.id,
														item.grantedCapabilities,
													),
										)
									}
								>
									{item.source._tag === "directory"
										? extensionMessage("extensions:reload")
										: extensionMessage("extensions:update")}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy !== null}
									onClick={() => {
										if (
											window.confirm(
												extensionMessage("extensions:remove_confirm", {
													name: item.manifest.name,
												}),
											)
										)
											void run(`remove:${item.id}`, () =>
												extensionActions.remove(item.id, false),
											);
									}}
								>
									{extensionMessage("extensions:remove")}
								</Button>
							</div>
						</div>
					))
				)}
			</div>

			{logs.length > 0 && (
				<div className="max-h-48 overflow-auto rounded-md bg-muted/30 px-3 py-2 font-mono text-[10px] leading-relaxed">
					{logs.map((entry) => (
						<div
							key={entry.sequence}
							className={
								entry.stream === "stderr"
									? "text-destructive"
									: "text-muted-foreground"
							}
						>
							{entry.message}
						</div>
					))}
				</div>
			)}

			{contributions.some(
				(extension) => extension.contributions.themes.length > 0,
			) && (
				<div className="flex flex-col gap-1.5">
					<p className="font-medium text-foreground">
						{extensionMessage("extensions:themes")}
					</p>
					<div className="flex flex-wrap gap-1.5">
						{contributions.flatMap((extension) =>
							extension.contributions.themes.map((theme) => {
								const selected =
									themeSelection._tag === "extension" &&
									themeSelection.extensionId === extension.extensionId &&
									themeSelection.themeId === theme.id;
								return (
									<Button
										key={`${extension.extensionId}:${theme.id}`}
										size="sm"
										variant={selected ? "default" : "ghost"}
										onClick={() =>
											setThemeSelection({
												_tag: "extension",
												extensionId: extension.extensionId,
												themeId: theme.id,
											})
										}
									>
										{theme.name}
									</Button>
								);
							}),
						)}
					</div>
				</div>
			)}

			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<p className="font-medium text-foreground">
						{extensionMessage("extensions:catalog")}
					</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy !== null}
						onClick={() =>
							void run("marketplace", async () =>
								setMarketplace(await extensionActions.marketplace(true)),
							)
						}
					>
						{extensionMessage("extensions:refresh")}
					</Button>
				</div>
				{marketplace.length === 0 ? (
					<p className="rounded-md bg-muted/25 px-3 py-3 text-muted-foreground">
						{extensionMessage("extensions:catalog_empty")}
					</p>
				) : (
					marketplace.map((entry) => (
						<div
							key={entry.id}
							className="flex items-center gap-3 rounded-md bg-muted/25 px-3 py-2"
						>
							<div className="min-w-0 flex-1">
								<p className="font-medium text-foreground">
									{entry.manifest.name}
								</p>
								<p className="truncate text-[10px] text-muted-foreground">
									{entry.changelog}
								</p>
							</div>
							<Button
								size="sm"
								disabled={
									busy !== null || (entry.installed && !entry.updateAvailable)
								}
								onClick={() =>
									void run(`market:${entry.id}`, async () => {
										if (
											!approve(
												extensionMessage,
												entry.manifest.name,
												entry.manifest.capabilities,
											)
										)
											return;
										await extensionActions.install(
											{ _tag: "marketplace", catalogId: entry.id },
											entry.manifest.capabilities,
										);
									})
								}
							>
								{entry.installed
									? entry.updateAvailable
										? extensionMessage("extensions:update")
										: extensionMessage("extensions:installed")
									: extensionMessage("extensions:install")}
							</Button>
						</div>
					))
				)}
			</div>
		</section>
	);
}
