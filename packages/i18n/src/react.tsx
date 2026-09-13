import { type ReactNode, useCallback } from "react";
import { I18nextProvider, Trans, useTranslation } from "react-i18next";
import { i18n, type Namespace } from "./index.ts";

export function LocalizationProvider({ children }: { children: ReactNode }) {
	return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
/** Subscribe at the component boundary, including memoized components. */
export function useMessages(namespaces: Namespace | Namespace[]) {
	const { t } = useTranslation(namespaces, { i18n });
	const message = useCallback(
		(
			key: import("./index.ts").MessageKey,
			values?: import("./index.ts").MessageValues,
		): string => String(t(key, values)),
		[t],
	);
	return { message };
}

/** Rich messages can reorder only components explicitly supplied by application code. */
export function RichMessage({
	id,
	values,
	components,
}: {
	id: import("./index.ts").MessageKey;
	values?: import("./index.ts").MessageValues;
	components: Readonly<Record<string, import("react").ReactElement>>;
}) {
	useMessages(id.split(":")[0] as Namespace);
	return (
		<Trans
			i18n={i18n}
			i18nKey={String(id)}
			values={values}
			components={components}
			shouldUnescape={false}
		/>
	);
}
