import deploymentProfiles from "./deployment-profiles.json" with {
	type: "json",
};

/** Public relay and identity configuration for each hosted deployment. */
export const PUBLIC_DEPLOYMENT_PROFILES = deploymentProfiles;

export const PRODUCTION_RELAY_URL =
	PUBLIC_DEPLOYMENT_PROFILES.production.relayUrl;
export const STAGING_RELAY_URL = PUBLIC_DEPLOYMENT_PROFILES.staging.relayUrl;
export const WORKOS_PUBLIC_CLIENT_ID =
	PUBLIC_DEPLOYMENT_PROFILES.production.workosPublicClientId;
export const WORKOS_STAGING_PUBLIC_CLIENT_ID =
	PUBLIC_DEPLOYMENT_PROFILES.staging.workosPublicClientId;
