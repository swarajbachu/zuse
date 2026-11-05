import type {
	DurableObjectNamespace,
	DurableObjectState,
	Request as WorkerRequest,
} from "@cloudflare/workers-types";
import { makeApiStringCipher } from "../../src/api-sealing.ts";
import { AutomationDurableObjectCore } from "../../src/automation-durable-object.ts";

export class AutomationScheduler extends AutomationDurableObjectCore {
	constructor(private readonly testState: DurableObjectState) {
		super(testState, {
			cipher: makeApiStringCipher(
				"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			),
			wake: async () => true,
		});
	}
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === "/__alarm")
			return Response.json({ alarm: await this.testState.storage.getAlarm() });
		return super.fetch(request);
	}
}
export default {
	fetch(request: WorkerRequest, env: { SCHEDULER: DurableObjectNamespace }) {
		return env.SCHEDULER.get(env.SCHEDULER.idFromName("owner")).fetch(request);
	},
};
