export const slackWebhookLocation = (path: string): RegExpExecArray | null =>
	/^\/slack\/webhook\/(T[A-Z0-9]+)\/([a-f0-9]{64})(?:\/([UW][A-Z0-9]+))?$/u.exec(
		path,
	);

/** Only the configured first-party endpoint, never arbitrary self-callbacks. */
export const isSlackWebhookTarget = (
	value: string,
	origin: string,
): boolean => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === origin &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			slackWebhookLocation(url.pathname) !== null
		);
	} catch {
		return false;
	}
};
