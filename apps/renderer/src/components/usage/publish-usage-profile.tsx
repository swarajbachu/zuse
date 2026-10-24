import type {
	EnvironmentId,
	UsageProfileSnapshot,
	UsageProfileState,
} from "@zuse/contracts";
import "@zuse/i18n/english/usage";
import { formatNumber } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import {
	usageProfileActivity,
	usageProfileUrl,
} from "@zuse/utils/usage-profile";
import { Share2 } from "lucide-react";
import {
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { runCloudControl } from "~/lib/control-plane-client";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "~/lib/renderer-account";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "~/lib/renderer-workspace";
import { loadUsageProfileSnapshot } from "~/lib/usage-profile-client";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

export function PublishUsageProfile({
	environmentId,
}: {
	environmentId: EnvironmentId;
}) {
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
		rendererAccountSnapshot,
	);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const { message } = useMessages(["usage"]);
	if (workspace.scope.kind !== "personal") return null;
	return (
		<ProfileDialog
			key={`${account.epoch}:${environmentId}`}
			environmentId={environmentId}
			label={message("usage:profile_publish")}
		/>
	);
}

function ProfileDialog({
	environmentId,
	label,
}: {
	environmentId: EnvironmentId;
	label: string;
}) {
	const { message } = useMessages(["usage"]);
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button
				variant="ghost"
				size="sm"
				className="h-7"
				onClick={() => setOpen(true)}
			>
				<Share2 className="size-3.5" />
				{label}
			</Button>
			<DialogPopup className="max-w-md p-4" bottomStickOnMobile={false}>
				<DialogTitle className="pr-6 text-sm font-medium">
					{message("usage:profile_title")}
				</DialogTitle>
				{open && <ProfileForm environmentId={environmentId} />}
			</DialogPopup>
		</Dialog>
	);
}

function ProfileForm({ environmentId }: { environmentId: EnvironmentId }) {
	const { message } = useMessages(["usage"]);
	const [state, setState] = useState<UsageProfileState | null>(null);
	const [snapshot, setSnapshot] = useState<UsageProfileSnapshot | null>(null);
	const [handle, setHandle] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [github, setGithub] = useState("");
	const [showCost, setShowCost] = useState(false);
	const [showHours, setShowHours] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const live = useRef(true);
	const fieldId = useId();
	useEffect(() => {
		let current = true;
		live.current = true;
		setError(null);
		const account = rendererAccountSnapshot();
		const valid = () => current && rendererAccountSnapshot() === account;
		void (async () => {
			try {
				const result = await runCloudControl(
					(client) => client["usage.profile.get"](),
					{ scope: "account" },
				);
				if (!valid()) return;
				setState(result);
				if (result.profile) {
					setHandle(result.profile.handle);
					setDisplayName(result.profile.displayName);
					setGithub(result.profile.github);
					setShowCost(result.profile.cost !== null);
					setShowHours(result.profile.hours !== null);
				}
			} catch {
				if (valid()) setError(message("usage:profile_load_error"));
			}
		})();
		void (async () => {
			try {
				const snapshot = await loadUsageProfileSnapshot(environmentId);
				if (valid()) setSnapshot(snapshot);
			} catch {
				if (valid()) setError(message("usage:profile_load_error"));
			}
		})();
		return () => {
			current = false;
			live.current = false;
		};
	}, [environmentId, attempt, message]);
	const stats = snapshot ? usageProfileActivity(snapshot) : null;
	const mutate = async (unpublish: boolean) => {
		if (busy || !state || (!unpublish && !snapshot)) return;
		setBusy(true);
		setError(null);
		const account = rendererAccountSnapshot();
		try {
			let result: UsageProfileState;
			if (unpublish)
				result = await runCloudControl(
					(client) => client["usage.profile.unpublish"](),
					{ scope: "account" },
				);
			else {
				if (!snapshot) return;
				const input = {
					...snapshot,
					handle,
					displayName: displayName.trim(),
					github,
					cost: showCost ? snapshot.cost : null,
					hours: showHours ? snapshot.hours : null,
				};
				result = await runCloudControl(
					(client) => client["usage.profile.publish"](input),
					{ scope: "account" },
				);
			}
			if (live.current && rendererAccountSnapshot() === account) {
				setState(result);
				setCopied(false);
			}
		} catch (cause) {
			if (live.current && rendererAccountSnapshot() === account)
				setError(
					message(
						typeof cause === "object" &&
							cause !== null &&
							"code" in cause &&
							cause.code === "conflict"
							? "usage:profile_handle_error"
							: "usage:profile_save_error",
					),
				);
		} finally {
			if (live.current && rendererAccountSnapshot() === account) setBusy(false);
		}
	};
	const inputClass = "h-7 bg-muted/50 text-xs";
	return (
		<form
			className="mt-3 flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain text-xs [&>*]:shrink-0"
			onSubmit={(event) => {
				event.preventDefault();
				void mutate(false);
			}}
		>
			<p className="leading-relaxed text-muted-foreground">
				{message("usage:profile_description")}
			</p>
			<label htmlFor={`${fieldId}-name`} className="flex flex-col gap-1">
				{message("usage:profile_name")}
				<Input
					className={inputClass}
					id={`${fieldId}-name`}
					value={displayName}
					onChange={(event) => setDisplayName(event.target.value)}
					maxLength={60}
					required
					disabled={busy || !state}
					autoComplete="name"
				/>
			</label>
			<label htmlFor={`${fieldId}-handle`} className="flex flex-col gap-1">
				{message("usage:profile_handle")}
				<div className="flex h-7 items-center gap-1 rounded-md bg-muted/50 pl-2">
					<span aria-hidden="true" className="text-muted-foreground">
						{message("usage:profile_url_prefix")}
					</span>
					<Input
						className="h-7 border-0 bg-transparent px-1 text-xs shadow-none"
						id={`${fieldId}-handle`}
						value={handle}
						onChange={(event) => {
							setHandle(event.target.value.toLowerCase());
							setError(null);
						}}
						minLength={3}
						maxLength={32}
						pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
						required
						disabled={busy || !state || state.profile !== null}
						spellCheck={false}
						autoComplete="off"
					/>
				</div>
			</label>
			<p className="text-[11px] text-muted-foreground">
				{message("usage:profile_handle_hint")}
			</p>
			<label htmlFor={`${fieldId}-github`} className="flex flex-col gap-1">
				{message("usage:profile_github")}
				<Input
					className={inputClass}
					id={`${fieldId}-github`}
					value={github}
					onChange={(event) => setGithub(event.target.value)}
					maxLength={39}
					pattern="[a-zA-Z0-9][a-zA-Z0-9-]{0,38}"
					disabled={busy || !state}
					spellCheck={false}
					autoComplete="off"
				/>
			</label>
			{stats && snapshot && (
				<section
					className="rounded-lg bg-muted/40 p-3"
					aria-label={message("usage:profile_preview")}
				>
					<p className="mb-2 text-muted-foreground">
						{message("usage:profile_preview")} · {snapshot?.year} ·{" "}
						{message("usage:profile_timezone")}
					</p>
					<p className="mb-2 text-[11px] text-muted-foreground">
						{snapshot.generatedAt.slice(0, 10)}
					</p>
					<div className="grid grid-cols-2 gap-3 tabular-nums">
						<div>
							<strong className="block text-base font-medium">
								{formatNumber(snapshot.sessionCount)}
							</strong>
							{message("usage:usage_dashboard_active_sessions")}
						</div>
						<div>
							<strong className="block text-base font-medium">
								{formatNumber(stats.totalTokens, {
									notation: "compact",
									maximumFractionDigits: 1,
								})}
							</strong>
							{message("usage:profile_tokens")}
						</div>
						<div>
							<strong className="block text-base font-medium">
								{stats.activeDays}
							</strong>
							{message("usage:profile_days")}
						</div>
						<div>
							<strong className="block text-base font-medium">
								{stats.longestStreak}
							</strong>
							{message("usage:profile_streak")}
						</div>
					</div>
					<details className="mt-3 text-muted-foreground">
						<summary className="cursor-pointer py-1">
							{snapshot.models.length} {message("usage:profile_models")}
						</summary>
						<ul className="max-h-28 overflow-y-auto">
							{snapshot.models.map((model) => (
								<li
									key={model.name}
									className="flex justify-between gap-3 py-1"
								>
									<span className="truncate">{model.name}</span>
									<span className="tabular-nums">
										{formatNumber(model.tokens)}
									</span>
								</li>
							))}
						</ul>
					</details>
					<details className="mt-1 text-muted-foreground">
						<summary className="cursor-pointer py-1">
							{message("usage:usage_dashboard_daily_usage")}
						</summary>
						<ul className="max-h-28 overflow-y-auto">
							{snapshot.days.map((day) => (
								<li
									key={day.date}
									className="flex justify-between gap-3 py-1 tabular-nums"
								>
									<span>{day.date}</span>
									<span>{formatNumber(day.tokens)}</span>
								</li>
							))}
						</ul>
					</details>
				</section>
			)}
			{snapshot && (
				<div className="flex flex-col gap-2">
					<label
						htmlFor={`${fieldId}-cost`}
						className="flex items-start justify-between gap-3"
					>
						<span className="flex flex-col gap-0.5">
							{message("usage:profile_show_cost")}
							<span className="text-[11px] text-muted-foreground">
								{snapshot.cost
									? message("usage:profile_show_cost_hint", {
											amount: formatNumber(snapshot.cost.usd, {
												style: "currency",
												currency: "USD",
												maximumFractionDigits: 0,
											}),
										})
									: message("usage:profile_cost_unavailable")}
							</span>
						</span>
						<Switch
							id={`${fieldId}-cost`}
							checked={showCost && snapshot.cost !== null}
							onCheckedChange={setShowCost}
							disabled={busy || !state || snapshot.cost === null}
						/>
					</label>
					<label
						htmlFor={`${fieldId}-hours`}
						className="flex items-start justify-between gap-3"
					>
						<span className="flex flex-col gap-0.5">
							{message("usage:profile_show_hours")}
							<span className="text-[11px] text-muted-foreground">
								{message("usage:profile_show_hours_hint")}
							</span>
						</span>
						<Switch
							id={`${fieldId}-hours`}
							checked={showHours}
							onCheckedChange={setShowHours}
							disabled={busy || !state}
						/>
					</label>
				</div>
			)}
			<p className="text-[11px] leading-relaxed text-muted-foreground">
				{message("usage:profile_privacy")}
			</p>
			{!state && !error && (
				<p role="status">{message("usage:profile_loading")}</p>
			)}
			{error && (
				<div role="alert">
					<p className="text-destructive">{error}</p>
					<Button
						className="mt-1 h-7"
						type="button"
						variant="ghost"
						disabled={busy}
						onClick={() => {
							setState(null);
							setSnapshot(null);
							setAttempt((value) => value + 1);
						}}
					>
						{message("usage:profile_retry")}
					</Button>
				</div>
			)}
			{state?.published && state.profile && (
				<div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-2">
					<span className="truncate">
						{usageProfileUrl(state.profile.handle)}
					</span>
					<Button
						type="button"
						variant="ghost"
						className="h-7 shrink-0"
						onClick={() => {
							if (!state.profile) return;
							void navigator.clipboard
								.writeText(usageProfileUrl(state.profile.handle))
								.then(() => {
									if (live.current) setCopied(true);
								})
								.catch(() => setError(message("usage:profile_copy_error")));
						}}
					>
						{message(copied ? "usage:profile_copied" : "usage:profile_copy")}
					</Button>
				</div>
			)}
			{state && !state.published && state.profile && (
				<p role="status" className="text-muted-foreground">
					{message("usage:profile_unpublished")}
				</p>
			)}
			<div className="mt-1 flex justify-end gap-2">
				{state?.published && (
					<Button
						type="button"
						variant="ghost"
						className="h-7"
						disabled={busy}
						onClick={() => void mutate(true)}
					>
						{message("usage:profile_unpublish")}
					</Button>
				)}
				<Button
					type="submit"
					className="h-7"
					disabled={busy || !state || !snapshot || displayName.trim() === ""}
				>
					{message(
						busy
							? "usage:profile_saving"
							: state?.published
								? "usage:profile_update"
								: "usage:profile_publish",
					)}
				</Button>
			</div>
		</form>
	);
}
