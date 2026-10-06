import { ApiPaths, OrganizationError } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { organizationControlError } from "../../src/control-api-error";
import { makeOrganizationControlClient } from "../../src/organization-control-client";

test.each([
	"not-allowed",
	"not-found",
	"conflict",
	"invalid-request",
	"organization-limit-reached",
	"organization-member-limit-reached",
] as const)("organization adapters retain %s", (code) => {
	expect(organizationControlError(code).code).toBe(code);
});
test("unrelated infrastructure failures remain organization unavailability", () => {
	expect(organizationControlError("provider-unavailable").code).toBe(
		"unavailable",
	);
	expect(organizationControlError("invalid-state").code).toBe("unavailable");
});

test("organization operations reuse the account endpoints and unchanged payloads", async () => {
	const calls: Array<{ path: string; body?: unknown }> = [];
	const client = makeOrganizationControlClient((path, _schema, body) => {
		calls.push({ path, body });
		return Effect.die("captured");
	});
	const get = { organizationId: "org_a" };
	const create = {
		name: "Team",
		operationId: "00000000-0000-4000-8000-000000000001",
	};
	const invite = {
		...get,
		email: "finance@example.com",
		role: "billing" as const,
	};
	const revoke = { ...get, invitationId: "invite_a" };
	const member = { ...get, memberId: "member_a" };
	const role = { ...member, role: "member" as const };
	const operations = [
		client["organizations.list"]({}),
		client["organizations.get"](get),
		client["organizations.create"](create),
		client["organizations.invite"](invite),
		client["organizations.revokeInvite"](revoke),
		client["organizations.setRole"](role),
		client["organizations.removeMember"](member),
	];
	await Promise.all(
		operations.map((operation) => Effect.runPromiseExit(operation)),
	);
	expect(calls).toEqual([
		{ path: ApiPaths.organizations, body: undefined },
		{ path: ApiPaths.organizationDetails, body: get },
		{ path: ApiPaths.organizations, body: create },
		{ path: ApiPaths.organizationInvite, body: invite },
		{ path: ApiPaths.organizationRevokeInvite, body: revoke },
		{ path: ApiPaths.organizationSetRole, body: role },
		{ path: ApiPaths.organizationRemoveMember, body: member },
	]);
});

test("acknowledged mutations return void through the existing response schema", async () => {
	const client = makeOrganizationControlClient((_path, schema) =>
		Schema.decodeUnknownEffect(schema)({ ok: true }),
	);
	await expect(
		Effect.runPromise(
			client["organizations.removeMember"]({
				organizationId: "org_a",
				memberId: "member_a",
			}),
		),
	).resolves.toBeUndefined();
});

test("preserves member-limit errors from the transport", async () => {
	const failure = new OrganizationError({
		code: "organization-member-limit-reached",
	});
	const client = makeOrganizationControlClient(() => Effect.fail(failure));
	const result = await Effect.runPromise(
		client["organizations.invite"]({
			organizationId: "org_a",
			email: "sixth@example.com",
			role: "member",
		}).pipe(Effect.flip),
	);
	expect(result).toBe(failure);
});

test("capabilities use the account endpoint and decode both creation and team access", async () => {
	let requested: string | undefined;
	const client = makeOrganizationControlClient((path, schema, body) => {
		requested = path;
		expect(body).toBeUndefined();
		return Schema.decodeUnknownEffect(schema)({
			canCreate: false,
			organizations: [{ id: "org-a", name: "Team", role: "member" }],
		});
	});
	expect(
		await Effect.runPromise(client["organizations.capabilities"]({})),
	).toMatchObject({ canCreate: false, organizations: [{ id: "org-a" }] });
	expect(requested).toBe(ApiPaths.organizationCapabilities);
});
