// Prefer Boat names while retaining already-installed Box secrets and settings.
// Explicit empty/false Boat values must not fall back to legacy configuration.
export const readBoatEnvironment = (environment: object) => {
	const env = environment as Readonly<Record<string, string | undefined>>;
	const settings = {
		BOAT_ADAPTER_ENABLED: env.BOAT_ADAPTER_ENABLED ?? env.BOX_ADAPTER_ENABLED,
		BOAT_API_KEY: env.BOAT_API_KEY ?? env.BOX_API_KEY,
		BOAT_API_BASE_URL: env.BOAT_API_BASE_URL ?? env.BOX_API_BASE_URL,
		BOAT_TEMPLATE_SNAPSHOT:
			env.BOAT_TEMPLATE_SNAPSHOT ?? env.BOX_TEMPLATE_SNAPSHOT,
		BOAT_TEMPLATE_VERSION:
			env.BOAT_TEMPLATE_VERSION ?? env.BOX_TEMPLATE_VERSION,
		BOAT_MACHINE_TYPE: env.BOAT_MACHINE_TYPE ?? env.BOX_MACHINE_TYPE,
		BOAT_HOSTED_PORT_DOMAIN:
			env.BOAT_HOSTED_PORT_DOMAIN ?? env.BOX_HOSTED_PORT_DOMAIN,
		BOAT_WEBHOOK_SECRET: env.BOAT_WEBHOOK_SECRET ?? env.BOX_WEBHOOK_SECRET,
	};
	return Object.fromEntries(
		Object.entries(settings).filter(([, value]) => value !== undefined),
	) as typeof settings;
};
