import { makeCloudControlClient } from "@zuse/client-runtime/cloud-control-client";
import { makeCloudControlRequest } from "@zuse/client-runtime/cloud-control-request";
import { CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect } from "effect";
import { rendererApiUrl } from "./api-url.ts";
import { hostedAccessToken, hostedSessionEpoch } from "./hosted-connect.ts";

const request = makeCloudControlRequest({
	token: hostedAccessToken,
	epoch: hostedSessionEpoch,
	url: (path) => `${rendererApiUrl()}${path}`,
});
export const hostedControlClient = makeCloudControlClient((...args) =>
	request(...args).pipe(
		Effect.timeout("30 seconds"),
		Effect.mapError((cause) =>
			cause instanceof CloudWorkspaceOpError
				? cause
				: new CloudWorkspaceOpError({ code: "provider-unavailable" }),
		),
	),
);
