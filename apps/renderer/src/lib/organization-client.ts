import { makeAccountControlRequest } from "@zuse/client-runtime/cloud-control-request";
import { organizationControlError } from "@zuse/client-runtime/control-api-error";
import { makeOrganizationControlClient } from "@zuse/client-runtime/organization-control-client";
import type { MemoizeRpcs } from "@zuse/contracts";
import { Effect } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { runControlPlane } from "./control-plane-client.ts";
import { isHostedProduct } from "./platform-capabilities.ts";
import {
	assertRendererAccountCurrent,
	type RendererAccountSnapshot,
	rendererAccountSnapshot,
} from "./renderer-account.ts";

type OrganizationRpc = Extract<
	RpcGroup.Rpcs<typeof MemoizeRpcs>,
	{
		readonly _tag:
			| "organizations.list"
			| "organizations.capabilities"
			| "organizations.get"
			| "organizations.create"
			| "organizations.invite"
			| "organizations.revokeInvite"
			| "organizations.setRole"
			| "organizations.removeMember"
			| "organizations.githubAuthorize"
			| "organizations.githubConnection"
			| "organizations.domains"
			| "organizations.domainAdd"
			| "organizations.domainRemove"
			| "organizations.domainRestore"
			| "organizations.githubSettings"
			| "organizations.githubPolicy"
			| "organizations.githubRestore";
	}
>;
type OrganizationClient = {
	[Operation in OrganizationRpc as Operation["_tag"]]: (
		input: Rpc.PayloadConstructor<Operation>,
	) => Effect.Effect<Rpc.Success<Operation>, unknown>;
};

const makeHostedClient = (
	account: RendererAccountSnapshot,
): OrganizationClient => {
	const request = makeAccountControlRequest({
		isCurrent: () => rendererAccountSnapshot() === account,
		toError: organizationControlError,
		send: async (path, method, body, signal) => {
			const { hostedAccountRequest } = await import("./hosted-connect.ts");
			assertRendererAccountCurrent(account);
			return hostedAccountRequest(path, body, { method, signal });
		},
	});
	return makeOrganizationControlClient((path, schema, body) =>
		request(path, schema, body === undefined ? "GET" : "POST", body),
	);
};

/** Organization administration belongs to the user's account, not the selected host. */
export const runOrganizations = async <A>(
	run: (client: OrganizationClient) => Effect.Effect<A, unknown>,
): Promise<A> => {
	if (!isHostedProduct()) return runControlPlane(run, { scope: "account" });
	const account = rendererAccountSnapshot();
	try {
		return await Effect.runPromise(run(makeHostedClient(account)));
	} finally {
		assertRendererAccountCurrent(account);
	}
};
