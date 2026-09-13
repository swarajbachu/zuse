import { Context } from "effect";

/** Trusted first-party destinations. Public callers cannot configure this receiver. */
export class ApiInternalWebhooks extends Context.Service<
	ApiInternalWebhooks,
	{
		accepts(url: string): boolean;
		receive(request: Request): Promise<Response>;
	}
>()("@zuse/api/ApiInternalWebhooks") {}
