import {
	isAnalyticsEventName,
	sanitizeAnalyticsProperties,
} from "@zuse/analytics";

interface PostHogEventEnvelope {
	event: string;
	properties?: Record<string, unknown>;
}

export const sanitizePostHogEvent = <Event extends PostHogEventEnvelope>(
	event: Event | null,
): Event | null => {
	if (!event || typeof event.event !== "string") return null;
	const ingestToken = event.properties?.token;
	if (event.event.startsWith("$")) {
		if (event.event !== "$identify") return null;
		const properties = event.properties ?? {};
		event.properties = {
			...(typeof ingestToken === "string" ? { token: ingestToken } : {}),
			distinct_id: properties.distinct_id,
			$anon_distinct_id: properties.$anon_distinct_id,
		};
		return event;
	}
	if (!isAnalyticsEventName(event.event)) return null;
	const distinctId = event.properties?.distinct_id;
	event.properties = sanitizeAnalyticsProperties(
		event.event,
		event.properties ?? {},
	);
	if (typeof ingestToken === "string") event.properties.token = ingestToken;
	if (typeof distinctId === "string") event.properties.distinct_id = distinctId;
	return event;
};
