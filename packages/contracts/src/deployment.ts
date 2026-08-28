import deploymentProfiles from "./deployment-profiles.json" with {
	type: "json",
};

/** Public api and identity configuration for each hosted deployment. */
export const PUBLIC_DEPLOYMENT_PROFILES = deploymentProfiles;

export const PRODUCTION_API_URL = PUBLIC_DEPLOYMENT_PROFILES.production.apiUrl;
export const STAGING_API_URL = PUBLIC_DEPLOYMENT_PROFILES.staging.apiUrl;
export const WORKOS_PUBLIC_CLIENT_ID =
	PUBLIC_DEPLOYMENT_PROFILES.production.workosPublicClientId;
export const WORKOS_STAGING_PUBLIC_CLIENT_ID =
	PUBLIC_DEPLOYMENT_PROFILES.staging.workosPublicClientId;
