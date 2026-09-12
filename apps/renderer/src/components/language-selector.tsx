import type { LocalePreference } from "@zuse/contracts";
import { isLocalePreference, localeNames } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { useId, useState } from "react";
import {
	LanguageChangeError,
	setLanguage,
	useLocaleSnapshot,
} from "../lib/localization.ts";

export function LanguageSelector() {
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
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-3">
				<label htmlFor={id} className="text-sm">
					{message("common:language")}
				</label>
				<select
					id={id}
					className="h-7 max-w-[65%] rounded-md bg-muted px-2 text-xs text-foreground"
					value={locale.preference}
					disabled={saving}
					onChange={(event) => {
						if (isLocalePreference(event.target.value))
							void change(event.target.value);
					}}
				>
					<option value="system">{message("common:system")}</option>
					{locale.available.map((value) => (
						<option key={value} value={value} lang={value}>
							{localeNames[value]}
						</option>
					))}
				</select>
			</div>
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
		</div>
	);
}
