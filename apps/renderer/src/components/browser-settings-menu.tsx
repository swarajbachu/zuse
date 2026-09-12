import "@zuse/i18n/english/settings";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Check,
	Cookie,
	EllipsisVertical,
	KeyRound,
	Settings,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { BrowserCookieImportStatus } from "../lib/bridge.ts";
import { BrowserProfileSelect } from "./browser-profile-select.tsx";
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
export function BrowserSettingsMenu({
	status,
	busy,
	onImport,
	onClearBrowsingData,
	onOpenSettings,
}: {
	status: BrowserCookieImportStatus;
	busy: boolean;
	onImport: (profileId?: string) => Promise<void>;
	onClearBrowsingData: () => Promise<void>;
	onOpenSettings: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [importOpen, setImportOpen] = useState(false);
	const [clearOpen, setClearOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedProfileId, setSelectedProfileId] = useState<
		string | undefined
	>(status.selectedProfileId ?? status.availableProfiles[0]?.id);
	const selectedProfile =
		status.availableProfiles.find(
			(profile) => profile.id === selectedProfileId,
		) ?? status.availableProfiles[0];
	useEffect(() => {
		setSelectedProfileId((current) =>
			status.availableProfiles.some((profile) => profile.id === current)
				? current
				: (status.selectedProfileId ?? status.availableProfiles[0]?.id),
		);
	}, [status.availableProfiles, status.selectedProfileId]);
	const openImport = () => {
		setError(null);
		setSelectedProfileId(
			status.selectedProfileId ?? status.availableProfiles[0]?.id,
		);
		setImportOpen(true);
	};
	const openSettings = () => {
		setError(null);
		onOpenSettings();
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
					aria-label={uiMessage("settings:browser_settings_menu_browser_menu")}
				>
					<EllipsisVertical className="size-3.5" />
				</MenuTrigger>
				<MenuPopup align="end" className="w-60 rounded-xl">
					<MenuItem onClick={openImport}>
						<Cookie />
						{uiMessage(
							"settings:browser_settings_menu_import_browser_sessions",
						)}
					</MenuItem>
					<MenuItem onClick={openSettings}>
						<KeyRound />
						{uiMessage("settings:browser_settings_menu_passwords_and_autofill")}
					</MenuItem>
					<MenuSeparator />
					<MenuItem onClick={openClear}>
						<Trash2 />
						{uiMessage("settings:browser_settings_menu_clear_browsing_data")}
					</MenuItem>
					<MenuSeparator />
					<MenuItem onClick={openSettings}>
						<Settings />
						{uiMessage("settings:browser_settings_menu_browser_settings")}
					</MenuItem>
				</MenuPopup>
			</Menu>

			<Dialog open={importOpen} onOpenChange={setImportOpen}>
				<DialogPopup className="max-w-md rounded-xl">
					<DialogHeader className="gap-1 px-4 pb-3 pt-4">
						<DialogTitle className="text-lg">
							{uiMessage(
								"settings:browser_settings_menu_import_from_your_browser",
							)}
						</DialogTitle>
						<DialogDescription className="text-xs">
							{uiMessage(
								"settings:browser_settings_menu_bring_signed_in_sessions_into_the_built_in_browser",
							)}
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-3 px-4 pb-4 pt-0" scrollFade={false}>
						<div className="grid grid-cols-[4rem_1fr] items-center gap-2 text-xs">
							<span className="text-muted-foreground">
								{uiMessage("settings:browser_settings_menu_browser")}
							</span>
							<BrowserProfileSelect
								profiles={status.availableProfiles}
								value={selectedProfileId}
								onValueChange={setSelectedProfileId}
								className="min-w-0 bg-muted/70 shadow-none"
							/>
						</div>
						<p className="text-[11px] text-muted-foreground">
							{selectedProfile
								? uiMessage(
										"settings:browser_settings_menu_close_completely_before_importing",
										{ source: String(selectedProfile.source) },
									)
								: (status.message ?? "No supported browser profile was found.")}
						</p>
						{selectedProfile ? (
							<p className="rounded-md bg-muted/45 px-2.5 py-2 text-[11px] text-muted-foreground">
								{uiMessage(
									"settings:browser_settings_menu_macos_may_ask_zuse_or_electron_in_development_to_access_safe_sentence",
									{ value: selectedProfile.source },
								)}
							</p>
						) : null}
						<div className="divide-y divide-border/60 rounded-lg bg-muted/45 px-3">
							<ImportDataRow
								icon={<Cookie className="size-3.5" />}
								label={uiMessage(
									"settings:browser_settings_menu_cookies_and_signed_in_sessions",
								)}
								detail="Valid cookies from the selected profile"
							/>
							<ImportDataRow
								icon={<KeyRound className="size-3.5" />}
								label={uiMessage("settings:browser_settings_menu_passwords")}
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
							{uiMessage("common:cancel")}
						</Button>
						<Button
							size="xs"
							loading={busy}
							disabled={!status.supported || selectedProfileId === undefined}
							onClick={() =>
								void run(
									() => onImport(selectedProfileId),
									() => setImportOpen(false),
								)
							}
						>
							{uiMessage("settings:browser_settings_menu_import_sessions")}
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>

			<AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
				<AlertDialogPopup className="max-w-sm rounded-xl">
					<AlertDialogHeader className="gap-1 px-4 pb-3 pt-4">
						<AlertDialogTitle className="text-lg">
							{uiMessage(
								"settings:browser_settings_menu_clear_browsing_data_2",
							)}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-xs">
							{uiMessage(
								"settings:browser_settings_menu_this_removes_cookies_site_storage_and_cache_from_the_built_in_browser",
							)}
						</AlertDialogDescription>
						{error ? (
							<p className="text-[11px] text-destructive-foreground">{error}</p>
						) : null}
					</AlertDialogHeader>
					<AlertDialogFooter className="px-4 py-2">
						<AlertDialogClose render={<Button size="xs" variant="ghost" />}>
							{uiMessage("common:cancel")}
						</AlertDialogClose>
						<Button
							size="xs"
							variant="destructive"
							loading={busy}
							onClick={() =>
								void run(onClearBrowsingData, () => setClearOpen(false))
							}
						>
							{uiMessage("settings:browser_settings_menu_clear_data")}
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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	return (
		<div className="flex min-h-12 items-center gap-2.5 py-2">
			<span className="text-muted-foreground">{icon}</span>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium text-foreground">{label}</p>
				<p className="truncate text-[11px] text-muted-foreground">{detail}</p>
			</div>
			{enabled ? (
				<Check
					className="size-3.5 text-primary"
					aria-label={uiMessage("settings:browser_settings_menu_included")}
				/>
			) : (
				<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
					{uiMessage("settings:browser_settings_menu_per_site")}
				</span>
			)}
		</div>
	);
}
