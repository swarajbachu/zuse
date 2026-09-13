/** Installation-local presentation state; never stored in remote environment settings. */
export type DesktopLocale =
	| "en"
	| "fr"
	| "de"
	| "zh-Hans"
	| "zh-Hant"
	| "ja"
	| "ko"
	| "en-XA";
export type LocalePreference = "system" | DesktopLocale;
export interface LocaleSnapshot {
	readonly version: 1;
	/** Monotonic within the desktop process, including system-language changes. */
	readonly revision: number;
	readonly preference: LocalePreference;
	readonly locale: DesktopLocale;
	readonly available: readonly DesktopLocale[];
}
export interface LocaleBridge {
	readonly get: () => Promise<LocaleSnapshot>;
	readonly set: (preference: LocalePreference) => Promise<LocaleSnapshot>;
	readonly onChange: (
		listener: (snapshot: LocaleSnapshot) => void,
	) => () => void;
}
