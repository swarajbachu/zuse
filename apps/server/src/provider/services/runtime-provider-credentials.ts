import type { ProviderId } from "@zuse/contracts";
import { Context } from "effect";
import type { ProviderCredential } from "./credentials-service.ts";

export type RuntimeProviderCredentialResolver = (
	providerId: ProviderId,
) => Promise<ProviderCredential | null>;

/**
 * Process-memory credential seam used by cloud runtimes. Local and SSH
 * runtimes leave it unconfigured and continue using CredentialsService.
 */
export class RuntimeProviderCredentials extends Context.Service<
	RuntimeProviderCredentials,
	{
		readonly resolve: RuntimeProviderCredentialResolver;
		readonly install: (
			resolver: RuntimeProviderCredentialResolver,
		) => () => void;
	}
>()("zuse/RuntimeProviderCredentials") {}

export const makeRuntimeProviderCredentials =
	(): RuntimeProviderCredentials["Service"] => {
		let current: RuntimeProviderCredentialResolver | null = null;
		return RuntimeProviderCredentials.of({
			resolve: (providerId) =>
				current === null ? Promise.resolve(null) : current(providerId),
			install: (resolver) => {
				current = resolver;
				return () => {
					if (current === resolver) current = null;
				};
			},
		});
	};
