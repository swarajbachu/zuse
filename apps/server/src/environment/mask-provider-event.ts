import type { ProviderDriverEvent } from "@zuse/agents/kernel/driver";
import { createSecretMasker } from "@zuse/utils/environment";

/** Provider text checkpoints are cumulative, so withhold a possible secret suffix
 * until a later checkpoint disambiguates it. Never change correlation identifiers. */
export function createProviderEventMasker(
	secrets: readonly string[],
): (event: ProviderDriverEvent) => ProviderDriverEvent {
	if (secrets.length === 0) return (event) => event;
	const masker = createSecretMasker(secrets);
	const maskString = (text: string) => masker.write(text) + masker.end();
	const mask = (value: unknown): unknown => {
		if (typeof value === "string") return maskString(value);
		if (Array.isArray(value)) return value.map(mask);
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [key, mask(child)]),
			);
		return value;
	};
	return (event) => {
		if (event._tag === "AssistantMessage" || event._tag === "Thinking") {
			const text = masker.write(event.text);
			const suffix = masker.end();
			return {
				...event,
				text: text + (event.checkpoint?.final === false ? "" : suffix),
			};
		}
		if (event._tag === "ToolUse") return { ...event, input: mask(event.input) };
		if (event._tag === "ToolResult")
			return { ...event, output: mask(event.output) };
		// Other events may contain diagnostics or user-facing error strings.
		return Object.fromEntries(
			Object.entries(event).map(([key, value]) => [
				key,
				["message", "reason", "description", "error", "title"].includes(key)
					? mask(value)
					: value,
			]),
		) as ProviderDriverEvent;
	};
}

export function maskProviderEvent(
	event: ProviderDriverEvent,
	secrets: readonly string[],
): ProviderDriverEvent {
	return createProviderEventMasker(secrets)(event);
}
