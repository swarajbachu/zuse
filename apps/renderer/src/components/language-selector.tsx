import type { LocalePreference } from "@zuse/contracts";
import { isLocalePreference, localeNames } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { useId, useState } from "react";
import {
	LanguageChangeError,
	setLanguage,
	useLocaleSnapshot,
} from "../lib/localization.ts";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";
import { SettingsRow } from "./ui/settings-panel.tsx";

export function LanguageSelector({
	settingsRow = false,
}: {
	settingsRow?: boolean;
}) {
	const { message } = useMessages("common");
	const id = useId();
	const locale = useLocaleSnapshot();
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState<"save" | "load" | null>(null);
	const [lastRequested, setLastRequested] =
		useState<LocalePreference>("system");
	const change = async (preference: LocalePreference) => {
		setSaving(true);
		setFailed(null);
		setLastRequested(preference);
		try {
			await setLanguage(preference);
		} catch (error) {
			setFailed(error instanceof LanguageChangeError ? error.kind : "save");
		} finally {
			setSaving(false);
		}
	};
	const actionClassName =
		"h-7 rounded-md bg-muted px-2 text-xs text-foreground";
	const items = [
		{ value: "system", label: message("common:system") },
		...locale.available.map((value) => ({ value, label: localeNames[value] })),
	];
	const control = (
		<Select
			value={locale.preference}
			items={items}
			disabled={saving}
			onValueChange={(value) => {
				if (isLocalePreference(value)) void change(value);
			}}
		>
			<SelectTrigger
				id={id}
				aria-label={message("common:language")}
				className="h-7 w-40"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectPopup>
				{items.map(({ value, label }) => (
					<SelectItem
						key={value}
						value={value}
						lang={value === "system" ? undefined : value}
					>
						{label}
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
	const feedback = (
		<>
			{failed && (
				<div className="space-y-1.5">
					<p role="alert" className="text-xs text-destructive">
						{message(
							failed === "load"
								? "common:loadLanguageError"
								: "common:saveLanguageError",
						)}
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							className={actionClassName}
							onClick={() => void change(lastRequested)}
						>
							{message("common:retry")}
						</button>
						{failed === "load" && (
							<button
								type="button"
								className={actionClassName}
								onClick={() => void change("en")}
							>
								{message("common:useEnglish")}
							</button>
						)}
					</div>
				</div>
			)}
			{import.meta.env.DEV && locale.locale !== "en" && (
				<p className="text-xs text-muted-foreground">
					{message("common:draftNotice")}
				</p>
			)}
		</>
	);
	if (settingsRow) {
		return (
			<SettingsRow title={message("common:language")} action={control}>
				{feedback}
			</SettingsRow>
		);
	}
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-3">
				<label htmlFor={id} className="text-sm">
					{message("common:language")}
				</label>
				{control}
			</div>
			{feedback}
		</div>
	);
}
