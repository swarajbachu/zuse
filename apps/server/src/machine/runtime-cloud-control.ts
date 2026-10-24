import { Context } from "effect";

/** Installed at enrollment; reads the live credential on every request. */
export class RuntimeCloudControl extends Context.Service<
	RuntimeCloudControl,
	{
		current: null | {
			readonly workspaceId: string;
			/** Owner-scoped orchestration through the allowlisted control proxy. */
			request(path: string, method: string, body?: unknown): Promise<Response>;
			/** Dedicated `/runtime/*` API routes, authenticated as this workspace. */
			runtimeRequest(
				path: string,
				method: string,
				body?: unknown,
			): Promise<Response>;
		};
	}
>()("zuse/RuntimeCloudControl") {}
