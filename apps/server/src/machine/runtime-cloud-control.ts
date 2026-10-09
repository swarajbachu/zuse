import { Context } from "effect";

/** Installed at enrollment; reads the live credential on every request. */
export class RuntimeCloudControl extends Context.Service<
	RuntimeCloudControl,
	{
		current: null | {
			request(path: string, method: string, body?: unknown): Promise<Response>;
		};
	}
>()("zuse/RuntimeCloudControl") {}
