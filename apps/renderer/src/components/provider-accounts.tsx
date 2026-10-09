import { refreshProviderMetadata } from "../lib/refresh-provider-metadata.ts";
import "@zuse/i18n/english/providers";
import type { NativeAccountProvider, ProviderAccount } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Effect } from "effect";
import {
	Check,
	Info,
	MoreHorizontal,
	Plus,
	SquareTerminal,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { runtimeOperationClient } from "../lib/runtime-operation-client.ts";
import { openExternal, useProviderLogin } from "../lib/use-provider-login.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "./ui/menu.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

/** The preference applies at the first turn; durable chats retain their account. */
export function ProviderAccountsControls({
	providerId,
	environmentId,
}: {
	providerId: NativeAccountProvider;
	environmentId: string;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const [accounts, setAccounts] = useState<readonly ProviderAccount[]>([]);
	const [available, setAvailable] = useState(false);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		const client = await runtimeOperationClient(environmentId);
		return Effect.runPromise(client["provider.accounts.list"]({ providerId }));
	}, [environmentId, providerId]);
	useEffect(() => {
		let active = true;
		void load()
			.then((result) => {
				if (active) {
					setAccounts(result.accounts);
					setAvailable(result.available);
				}
			})
			.catch((cause) => {
				if (active) setError(formatError(cause));
			});
		return () => {
			active = false;
		};
	}, [load]);
	const run = async (
		operation: (
			client: Awaited<ReturnType<typeof runtimeOperationClient>>,
		) => Effect.Effect<unknown, unknown>,
	) => {
		if (busy) return false;
		setBusy(true);
		setError(null);
		try {
			await Effect.runPromise(
				operation(await runtimeOperationClient(environmentId)),
			);
			const result = await load();
			setAccounts(result.accounts);
			setAvailable(result.available);
			await refreshProviderMetadata(environmentId);
			return true;
		} catch (cause) {
			setError(formatError(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};
	if (!available && !error) return null;
	const defaultSelected = !accounts.some((a) => a.preferred);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-7 items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<span className="text-[11px] font-medium text-muted-foreground">
						{t("providers:accounts_title")}
					</span>
					<Tooltip>
						<TooltipTrigger
							className="flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
							aria-label={t("providers:accounts_hint")}
						>
							<Info className="size-3" aria-hidden />
						</TooltipTrigger>
						<TooltipPopup className="max-w-64">
							{t("providers:accounts_hint")}
						</TooltipPopup>
					</Tooltip>
				</div>
				{available && (
					<Button
						className="h-7 px-2 text-[11px] text-muted-foreground"
						size="xs"
						variant="ghost"
						disabled={busy || adding}
						onClick={() => setAdding(true)}
					>
						<Plus className="size-3" />
						{t("providers:accounts_add")}
					</Button>
				)}
			</div>
			{available && (
				<div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-md bg-muted/30">
					<AccountRowShell
						leading={<SquareTerminal className="size-3" aria-hidden />}
						label={t("providers:accounts_default")}
						selected={defaultSelected}
						disabled={busy}
						onSelect={() =>
							void run((client) =>
								client["provider.accounts.preferred"]({
									providerId,
									id: null,
								}),
							)
						}
						trailing={<span className="w-7" aria-hidden />}
					/>
					{accounts.map((account) => (
						<ProviderAccountRow
							key={account.id}
							account={account}
							environmentId={environmentId}
							busy={busy}
							run={run}
						/>
					))}
					{adding && (
						<AccountNameForm
							initialName=""
							placeholder={t("providers:accounts_name")}
							submitLabel={t("common:add")}
							busy={busy}
							onCancel={() => setAdding(false)}
							onSubmit={(name) =>
								run((client) =>
									client["provider.accounts.save"]({ providerId, name }),
								).then((ok) => {
									if (ok) setAdding(false);
								})
							}
						/>
					)}
				</div>
			)}
			{error && (
				<p role="alert" className="text-[11px] text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

/** One account line: avatar, name, optional status, selection, then row actions. */
function AccountRowShell({
	leading,
	label,
	status,
	selected,
	disabled,
	onSelect,
	trailing,
}: {
	leading: ReactNode;
	label: string;
	status?: ReactNode;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
	trailing: ReactNode;
}) {
	const { message: t } = useMessages(["providers"]);
	return (
		<div
			className={cn(
				"group/account flex items-center gap-2 pr-0.5 pl-2.5",
				status ? "min-h-7 py-1" : "h-7",
			)}
		>
			<span
				aria-hidden
				className="flex size-4 shrink-0 items-center justify-center rounded bg-foreground/[0.07] text-[9px] font-semibold text-muted-foreground uppercase"
			>
				{leading}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-xs text-foreground">{label}</span>
				{status}
			</div>
			{selected ? (
				<span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 text-[10px] font-medium text-foreground">
					<Check className="size-2.5" strokeWidth={3} aria-hidden />
					{t("providers:accounts_selected")}
				</span>
			) : disabled ? null : (
				<Button
					className="h-7 px-2 text-[11px] text-muted-foreground opacity-0 group-hover/account:opacity-100 focus-visible:opacity-100"
					size="xs"
					variant="ghost"
					onClick={onSelect}
				>
					{t("providers:accounts_use")}
				</Button>
			)}
			{trailing}
		</div>
	);
}

function AccountNameForm({
	initialName,
	placeholder,
	submitLabel,
	busy,
	onCancel,
	onSubmit,
}: {
	initialName: string;
	placeholder?: string;
	submitLabel: string;
	busy: boolean;
	onCancel: () => void;
	onSubmit: (name: string) => Promise<void>;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const [name, setName] = useState(initialName);
	return (
		<form
			className="flex items-center gap-1 py-0.5 pr-0.5 pl-1"
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit(name);
			}}
		>
			<Input
				className="h-7 min-w-0 flex-1"
				autoFocus
				required
				maxLength={80}
				value={name}
				aria-label={t("providers:accounts_name")}
				placeholder={placeholder}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onCancel();
					}
				}}
			/>
			<Button
				className="h-7"
				size="sm"
				type="submit"
				disabled={busy || !name.trim()}
			>
				{submitLabel}
			</Button>
			<Button
				className="h-7"
				size="sm"
				variant="ghost"
				type="button"
				onClick={onCancel}
			>
				{t("common:cancel")}
			</Button>
		</form>
	);
}

function ProviderAccountRow({
	account,
	environmentId,
	busy,
	run,
}: {
	account: ProviderAccount;
	environmentId: string;
	busy: boolean;
	run: (
		operation: (
			client: Awaited<ReturnType<typeof runtimeOperationClient>>,
		) => Effect.Effect<unknown, unknown>,
	) => Promise<boolean>;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const [editing, setEditing] = useState(false);
	const login = useProviderLogin(account.providerId, {
		environmentId,
		accountId: account.id,
	});
	const state = login.state;
	if (editing) {
		return (
			<AccountNameForm
				initialName={account.name}
				submitLabel={t("common:save")}
				busy={busy}
				onCancel={() => setEditing(false)}
				onSubmit={(name) =>
					run((client) =>
						client["provider.accounts.save"]({
							providerId: account.providerId,
							id: account.id,
							name,
						}),
					).then((ok) => {
						if (ok) setEditing(false);
					})
				}
			/>
		);
	}
	const status =
		state.kind === "waiting" ? (
			<ShimmerText
				as="span"
				className="truncate text-[10px] text-muted-foreground"
			>
				{state.output || t("providers:accounts_waiting")}
			</ShimmerText>
		) : state.kind === "failed" ? (
			<span
				role="alert"
				title={state.reason}
				className="truncate text-[10px] text-destructive"
			>
				{state.reason}
			</span>
		) : state.kind === "success" ? (
			<span role="status" className="text-[10px] text-muted-foreground">
				{t("providers:accounts_signed_in")}
			</span>
		) : undefined;
	return (
		<AccountRowShell
			leading={account.name.trim().charAt(0)}
			label={account.name}
			status={status}
			selected={account.preferred}
			disabled={busy || state.kind === "waiting"}
			onSelect={() =>
				void run((client) =>
					client["provider.accounts.preferred"]({
						providerId: account.providerId,
						id: account.id,
					}),
				)
			}
			trailing={
				state.kind === "waiting" ? (
					<div className="flex shrink-0 items-center">
						{state.url && (
							<Button
								className="h-7 px-2 text-[11px]"
								size="xs"
								variant="ghost"
								onClick={() => {
									if (state.url) void openExternal(state.url);
								}}
							>
								{t("providers:accounts_open_browser")}
							</Button>
						)}
						<Button
							className="h-7 px-2 text-[11px] text-muted-foreground"
							size="xs"
							variant="ghost"
							onClick={login.cancel}
						>
							{t("common:cancel")}
						</Button>
					</div>
				) : (
					<Menu>
						<MenuTrigger
							render={
								<Button
									className="h-7 w-7 text-muted-foreground"
									size="icon-sm"
									variant="ghost"
									disabled={busy}
									aria-label={account.name}
								/>
							}
						>
							<MoreHorizontal className="size-3.5" />
						</MenuTrigger>
						<MenuPopup align="end">
							<MenuItem className="h-7" onClick={() => void login.start()}>
								{t("common:signIn")}
							</MenuItem>
							<MenuItem className="h-7" onClick={() => setEditing(true)}>
								{t("common:edit")}
							</MenuItem>
							<MenuSeparator />
							<MenuItem
								className="h-7"
								variant="destructive"
								onClick={() =>
									void run((client) =>
										client["provider.accounts.remove"]({
											providerId: account.providerId,
											id: account.id,
										}),
									)
								}
							>
								{t("common:remove")}
							</MenuItem>
						</MenuPopup>
					</Menu>
				)
			}
		/>
	);
}
