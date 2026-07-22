import {
	Check,
	Cookie,
	EllipsisVertical,
	KeyRound,
	Settings,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import type { BrowserCookieImportStatus } from "../lib/bridge.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "./ui/menu.tsx";

type NativeCredentialCapability = {
	readonly supported: boolean;
	readonly reason?: string;
};

export function BrowserSettingsMenu({
	status,
	credentialCapability,
	busy,
	domainGrantCount,
	onImport,
	onClearImported,
	onClearBrowsingData,
	onRevokeTaskAccess,
}: {
	status: BrowserCookieImportStatus;
	credentialCapability: NativeCredentialCapability | null;
	busy: boolean;
	domainGrantCount: number;
	onImport: () => Promise<void>;
	onClearImported: () => Promise<void>;
	onClearBrowsingData: () => Promise<void>;
	onRevokeTaskAccess: () => void;
}) {
	const [importOpen, setImportOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [clearOpen, setClearOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const openImport = () => {
		setError(null);
		setSettingsOpen(false);
		setImportOpen(true);
	};
	const openSettings = () => {
		setError(null);
		setSettingsOpen(true);
	};
	const openClear = () => {
		setError(null);
		setClearOpen(true);
	};

	const run = async (
		operation: () => Promise<void>,
		onSuccess?: () => void,
	) => {
		setError(null);
		try {
			await operation();
			onSuccess?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<>
			<Menu>
				<MenuTrigger
					className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					aria-label="Browser menu"
				>
					<EllipsisVertical className="size-3.5" />
				</MenuTrigger>
				<MenuPopup align="end" className="w-60 rounded-xl">
					<MenuItem onClick={openImport}>
						<Cookie />
						Import browser sessions…
					</MenuItem>
					<MenuItem onClick={openSettings}>
						<KeyRound />
						Passwords and autofill
					</MenuItem>
					<MenuSeparator />
					<MenuItem onClick={openClear}>
						<Trash2 />
						Clear browsing data…
					</MenuItem>
					<MenuSeparator />
					<MenuItem onClick={openSettings}>
						<Settings />
						Browser settings
					</MenuItem>
				</MenuPopup>
			</Menu>

			<Dialog open={importOpen} onOpenChange={setImportOpen}>
				<DialogPopup className="max-w-md rounded-xl">
					<DialogHeader className="gap-1 px-4 pb-3 pt-4">
						<DialogTitle className="text-lg">
							Import from your browser
						</DialogTitle>
						<DialogDescription className="text-xs">
							Bring signed-in sessions into the built-in browser.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-3 px-4 pb-4 pt-0" scrollFade={false}>
						<div className="grid grid-cols-[4rem_1fr] items-center gap-2 text-xs">
							<span className="text-muted-foreground">Browser</span>
							<div className="min-w-0 rounded-md bg-muted/70 px-2.5 py-1.5">
								<span className="font-medium text-foreground">
									{status.source ?? "Not detected"}
								</span>
								<span className="ml-2 text-muted-foreground">
									{status.profile ?? "No profile"}
								</span>
							</div>
						</div>
						<p className="text-[11px] text-muted-foreground">
							{status.source
								? `Close ${status.source} completely before importing.`
								: (status.message ?? "No supported browser profile was found.")}
						</p>
						<div className="divide-y divide-border/60 rounded-lg bg-muted/45 px-3">
							<ImportDataRow
								icon={<Cookie className="size-3.5" />}
								label="Cookies and signed-in sessions"
								detail="Valid cookies from the selected profile"
							/>
							<ImportDataRow
								icon={<KeyRound className="size-3.5" />}
								label="Passwords"
								detail="Never imported — requested per site from macOS"
								enabled={false}
							/>
						</div>
						{error ? (
							<p className="text-[11px] text-destructive-foreground">{error}</p>
						) : null}
					</DialogPanel>
					<DialogFooter className="px-4 py-2">
						<Button
							size="xs"
							variant="ghost"
							onClick={() => setImportOpen(false)}
						>
							Cancel
						</Button>
						<Button
							size="xs"
							loading={busy}
							disabled={!status.supported}
							onClick={() => void run(onImport, () => setImportOpen(false))}
						>
							Import sessions
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>

			<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<DialogPopup className="max-w-lg rounded-xl">
					<DialogHeader className="gap-1 px-4 pb-3 pt-4">
						<DialogTitle className="text-lg">Browser settings</DialogTitle>
						<DialogDescription className="text-xs">
							Sessions, password filling, and agent access.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-4 px-4 pb-4 pt-0" scrollFade={false}>
						<SettingsGroup title="Imported session">
							<SettingsRow
								label="Source"
								detail={`${status.source ?? "Not detected"} · ${status.profile ?? "No profile"}`}
								action={
									<Button size="xs" variant="settings" onClick={openImport}>
										Import…
									</Button>
								}
							/>
							<SettingsRow
								label="Session data"
								detail={`${status.importedCookieCount} cookies across ${status.importedDomainCount} domains${status.lastImportTime ? ` · ${new Date(status.lastImportTime).toLocaleString()}` : ""}`}
								action={
									<Button
										size="xs"
										variant="settings"
										disabled={status.importedCookieCount === 0 || busy}
										onClick={() => void run(onClearImported)}
									>
										Clear
									</Button>
								}
							/>
						</SettingsGroup>

						<SettingsGroup title="Passwords and autofill">
							<SettingsRow
								label="System Passwords"
								detail={
									credentialCapability?.supported
										? "Requested for the active website with system confirmation"
										: (credentialCapability?.reason ??
											"Checking system capability…")
								}
								action={
									<ShieldCheck className="size-4 text-muted-foreground" />
								}
							/>
						</SettingsGroup>

						<SettingsGroup title="Agent access">
							<SettingsRow
								label="Authenticated domains"
								detail={`${domainGrantCount} task grant${domainGrantCount === 1 ? "" : "s"} active`}
								action={
									<Button
										size="xs"
										variant="settings"
										disabled={domainGrantCount === 0}
										onClick={onRevokeTaskAccess}
									>
										Revoke
									</Button>
								}
							/>
						</SettingsGroup>
						{error ? (
							<p className="text-[11px] text-destructive-foreground">{error}</p>
						) : null}
					</DialogPanel>
					<DialogFooter className="px-4 py-2">
						<Button
							size="xs"
							variant="ghost"
							onClick={() => setSettingsOpen(false)}
						>
							Done
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>

			<AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
				<AlertDialogPopup className="max-w-sm rounded-xl">
					<AlertDialogHeader className="gap-1 px-4 pb-3 pt-4">
						<AlertDialogTitle className="text-lg">
							Clear browsing data?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-xs">
							This removes cookies, site storage, and cache from the built-in
							browser. It does not change your other browser.
						</AlertDialogDescription>
						{error ? (
							<p className="text-[11px] text-destructive-foreground">{error}</p>
						) : null}
					</AlertDialogHeader>
					<AlertDialogFooter className="px-4 py-2">
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<Button
							size="xs"
							variant="destructive"
							loading={busy}
							onClick={() =>
								void run(onClearBrowsingData, () => setClearOpen(false))
							}
						>
							Clear data
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}

function ImportDataRow({
	icon,
	label,
	detail,
	enabled = true,
}: {
	icon: ReactNode;
	label: string;
	detail: string;
	enabled?: boolean;
}) {
	return (
		<div className="flex min-h-12 items-center gap-2.5 py-2">
			<span className="text-muted-foreground">{icon}</span>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium text-foreground">{label}</p>
				<p className="truncate text-[11px] text-muted-foreground">{detail}</p>
			</div>
			{enabled ? (
				<Check className="size-3.5 text-primary" aria-label="Included" />
			) : (
				<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
					Per site
				</span>
			)}
		</div>
	);
}

function SettingsGroup({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section>
			<h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
				{title}
			</h3>
			<div className="divide-y divide-border/60 rounded-lg bg-muted/45 px-3">
				{children}
			</div>
		</section>
	);
}

function SettingsRow({
	label,
	detail,
	action,
}: {
	label: string;
	detail: string;
	action: ReactNode;
}) {
	return (
		<div className="flex min-h-12 items-center gap-3 py-2">
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium text-foreground">{label}</p>
				<p
					className="truncate text-[11px] text-muted-foreground"
					title={detail}
				>
					{detail}
				</p>
			</div>
			{action}
		</div>
	);
}
