import { openExternal } from "./platform-capabilities.ts";

export function isHttpUrl(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

/** Provider-supplied links must never invoke arbitrary OS protocols. */
export async function openHttpLink(url: string): Promise<void> {
	if (isHttpUrl(url)) await openExternal(url);
}
