import "@zuse/i18n/english/extensions";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";
import { useMessages as useExtensionMessages } from "@zuse/i18n/react";
import { PackageIcon } from "@zuse/icons/solid-rounded";
import { Schema } from "effect";
import { useEffect, useMemo, useState } from "react";
import { extensionActions } from "~/lib/extension-client-bus.ts";
import { useExtensionContributions } from "~/lib/extension-registry.tsx";
import { getLocalEnvironmentId } from "../../lib/rpc-client.ts";
import { useActiveContext } from "../../store/active-workspace.ts";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";

export function ExtensionAttachmentPicker({
	onSelect,
}: {
	readonly onSelect: (snapshot: ExtensionAttachmentSnapshot) => Promise<void>;
}) {
	const { message: extensionMessage } = useExtensionMessages(["extensions"]);
	const workspace = useActiveContext();
	const extensions = useExtensionContributions();
	const sources = useMemo(
		() =>
			extensions.flatMap((extension) =>
				extension.contributions.attachmentSources.map((source) => ({
					extensionId: extension.extensionId,
					source,
				})),
			),
		[extensions],
	);
	const [open, setOpen] = useState(false);
	const [sourceId, setSourceId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<ExtensionAttachmentSnapshot | null>(
		null,
	);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<
		ReadonlyArray<ExtensionAttachmentSnapshot>
	>([]);
	const [loading, setLoading] = useState(false);
	const active =
		sources.find(
			(item) => `${item.extensionId}:${item.source.id}` === sourceId,
		) ?? sources[0];
	const workspaceKey =
		workspace.status === "ready"
			? `${workspace.environmentId}:${workspace.rootPath}:${workspace.sessionId}`
			: "";
	useEffect(() => {
		setResults([]);
		setPreview(null);
		setError(null);
		setQuery("");
	}, [workspaceKey, sourceId]);

	useEffect(() => {
		if (
			!open ||
			active === undefined ||
			workspace.status !== "ready" ||
			workspace.worktreePending ||
			workspace.environmentId !== getLocalEnvironmentId()
		)
			return;
		let cancelled = false;
		const controller = new AbortController();
		const timeout = window.setTimeout(() => {
			setLoading(true);
			setError(null);
			setPreview(null);
			setResults([]);
			void Promise.resolve()
				.then(() =>
					Schema.decodeUnknownSync(active.source.search.input)({ query }),
				)
				.then((input) =>
					extensionActions.invoke(
						active.extensionId,
						active.source.search.name,
						input,
						{
							projectId: workspace.folderId,
							worktreeId: workspace.worktreeId,
							sessionId: workspace.sessionId,
						},
						controller.signal,
					),
				)
				.then((output) =>
					Schema.decodeUnknownSync(active.source.search.output)(output),
				)
				.then((next) => {
					if (!cancelled) setResults(next);
				})
				.catch((cause) => {
					console.error("[extensions] attachment search failed", cause);
					if (!cancelled) {
						setResults([]);
						setError(cause instanceof Error ? cause.message : String(cause));
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 100);
		return () => {
			cancelled = true;
			controller.abort();
			window.clearTimeout(timeout);
		};
	}, [active, open, query, workspaceKey]);

	if (
		sources.length === 0 ||
		workspace.status !== "ready" ||
		workspace.worktreePending ||
		workspace.environmentId !== getLocalEnvironmentId()
	)
		return null;
	return (
		<>
			<button
				type="button"
				className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
				aria-label={extensionMessage("extensions:attach")}
				onClick={() => setOpen(true)}
			>
				<HugeiconsIcon icon={PackageIcon} className="size-3.5" />
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogPopup className="w-[30rem] max-w-[calc(100vw-2rem)]">
					<DialogHeader>
						<DialogTitle>
							{active?.source.pickerTitle ??
								extensionMessage("extensions:context")}
						</DialogTitle>
					</DialogHeader>
					<DialogPanel className="flex flex-col gap-2">
						{sources.length > 1 ? (
							<div className="flex flex-wrap gap-1">
								{sources.map(({ extensionId, source }) => (
									<Button
										key={`${extensionId}:${source.id}`}
										type="button"
										variant={source === active?.source ? "secondary" : "ghost"}
										className="h-7"
										onClick={() => {
											setSourceId(`${extensionId}:${source.id}`);
											setQuery("");
										}}
									>
										{source.title}
									</Button>
								))}
							</div>
						) : null}
						<Input
							className="h-7"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={active?.source.searchPlaceholder}
						/>
						{error ? (
							<p role="alert" className="text-destructive">
								{error}
							</p>
						) : null}
						<div className="max-h-72 overflow-y-auto">
							{loading ? (
								<p className="p-3 text-xs text-muted-foreground">
									{extensionMessage("extensions:searching")}
								</p>
							) : results.length === 0 ? (
								<p className="p-3 text-xs text-muted-foreground">
									{extensionMessage("extensions:no_results")}
								</p>
							) : (
								results.map((snapshot) => (
									<button
										key={snapshot.id}
										type="button"
										className="flex min-h-9 w-full flex-col rounded-md px-2 py-1 text-left hover:bg-muted/60"
										onClick={() => {
											setPreview(snapshot);
										}}
									>
										<span className="text-xs text-foreground">
											{snapshot.title}
										</span>
										{snapshot.subtitle ? (
											<span className="text-[10px] text-muted-foreground">
												{snapshot.subtitle}
											</span>
										) : null}
									</button>
								))
							)}
						</div>
						{preview ? (
							<div className="space-y-2">
								<pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
									{preview.text}
								</pre>
								<Button
									className="h-7"
									onClick={() =>
										void onSelect(preview)
											.then(() => setOpen(false))
											.catch((cause) => setError(String(cause)))
									}
								>
									{extensionMessage("extensions:attach_selected")}
								</Button>
							</div>
						) : null}
					</DialogPanel>
				</DialogPopup>
			</Dialog>
		</>
	);
}
