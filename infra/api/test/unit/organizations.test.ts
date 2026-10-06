import { Layer, ManagedRuntime, Redacted } from "effect";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import {
	getOrganizationSharingDefaults,
	routeOrganizationRequest,
	setOrganizationSharingDefaults,
	validateOrganizationChatGrants,
} from "../../src/organizations.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

interface Member {
	id: string;
	user_id: string;
	organization_id: string;
	status: string;
	role: { slug: string };
	directory_managed?: boolean;
}
const member = (
	id: string,
	user: string,
	org: string,
	role = "member",
): Member => ({
	id,
	user_id: user,
	organization_id: org,
	status: "active",
	role: { slug: role },
});
const config = (organizationWorkspacesEnabled = true) =>
	configurationLayer({
		apiIssuer: "https://api.test",
		workosIssuer: "https://auth.test",
		workosJwksUrl: "https://auth.test/jwks",
		mintPrivateKey: Redacted.make("unused"),
		mintPublicKey: "unused",
		workosApiKey: Redacted.make("secret-workos-key"),
		organizationWorkspacesEnabled,
	});
const makeRuntime = () =>
	ManagedRuntime.make(
		Layer.mergeAll(
			CloudWorkspaceStoreMemory,
			config(),
			ApiStoreMemory,
			WorkosVerifierTest,
		),
	);

describe("organization access and lifecycle", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	let members: Member[];
	let metadata: Record<string, string>;
	let invitations: Array<{
		id: string;
		organization_id: string;
		email: string;
		state: string;
		expires_at: string;
	}>;
	let provider: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
	const call = (path: string, user: string, body?: unknown) =>
		runtime.runPromise(
			routeOrganizationRequest(
				new Request(`https://api.test/v1/organizations${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						authorization: `Bearer test-token:${user}:org-a`,
						"content-type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			),
		);
	beforeEach(() => {
		runtime = makeRuntime();
		metadata = { unrelated: "keep" };
		members = [
			member("owner", "alice", "org-a", "admin"),
			member("driver", "bob", "org-a"),
			member("other", "eve", "org-b", "admin"),
		];
		invitations = [
			{
				id: "invite",
				organization_id: "org-a",
				email: "guest@example.com",
				state: "pending",
				expires_at: "2030-01-01T00:00:00Z",
			},
		];
		provider = vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const json = (value: unknown, status = 200) =>
				new Response(JSON.stringify(value), { status });
			if (
				path === "/user_management/organization_memberships" &&
				method === "GET"
			) {
				return json({
					data: members.filter(
						(m) =>
							(!url.searchParams.has("user_id") ||
								url.searchParams.get("user_id") === m.user_id) &&
							(!url.searchParams.has("organization_id") ||
								url.searchParams.get("organization_id") === m.organization_id),
					),
					list_metadata: { after: null },
				});
			}
			if (path.startsWith("/user_management/organization_memberships/")) {
				const id = path.split("/").at(-1);
				const found = members.find((m) => m.id === id);
				if (!found) return json({}, 404);
				if (method === "DELETE") {
					members = members.filter((m) => m.id !== id);
					return new Response(null, { status: 204 });
				}
				if (method === "PUT")
					found.role.slug = JSON.parse(String(init?.body)).role_slug;
				return json(found);
			}
			if (path.startsWith("/organizations/")) {
				if (method === "PUT")
					metadata = JSON.parse(String(init?.body)).metadata;
				return json({ id: path.split("/").at(-1), name: "Acme", metadata });
			}
			if (path.startsWith("/user_management/users/"))
				return json({
					email: `${path.split("/").at(-1)}@example.com`,
					first_name: null,
					last_name: null,
				});
			if (path.startsWith("/user_management/invitations")) {
				if (method === "POST" && path === "/user_management/invitations") {
					const input = JSON.parse(String(init?.body));
					const existing = invitations.find(
						(entry) =>
							entry.email === input.email &&
							entry.organization_id === input.organization_id,
					);
					if (existing) return json(existing);
					const created = {
						id: `invite-${invitations.length}`,
						organization_id: input.organization_id,
						email: input.email,
						state: "pending",
						expires_at: "2030-01-01T00:00:00Z",
					};
					invitations.push(created);
					return json(created);
				}
				const value = {
					id: "invite",
					organization_id: "org-a",
					email: "guest@example.com",
					state: "pending",
					expires_at: "2030-01-01T00:00:00Z",
					token: "must-not-leak",
					accept_invitation_url: "https://secret.test",
				};
				return method === "GET" && path === "/user_management/invitations"
					? json({
							data: invitations.map((entry) => ({
								...entry,
								token: "must-not-leak",
								accept_invitation_url: "https://secret.test",
							})),
							list_metadata: { after: null },
						})
					: json(value);
			}
			throw new Error(`Unexpected provider request ${method} ${path}`);
		});
		vi.stubGlobal("fetch", provider);
	});
	afterEach(async () => {
		await runtime.dispose();
		vi.unstubAllGlobals();
	});

	it("persists future-chat defaults without overwriting unrelated organization metadata", async () => {
		metadata.zuse_creator = "alice";
		await expect(
			runtime.runPromise(getOrganizationSharingDefaults("org-a")),
		).resolves.toEqual({ audience: "organization", permission: "edit" });
		const defaults = { audience: "private", permission: "view" } as const;
		await expect(
			runtime.runPromise(
				setOrganizationSharingDefaults("bob", "org-a", defaults),
			),
		).rejects.toMatchObject({ code: "organization_access_denied" });
		await expect(
			runtime.runPromise(
				setOrganizationSharingDefaults("alice", "org-b", defaults),
			),
		).rejects.toMatchObject({ code: "organization_access_denied" });
		await expect(
			runtime.runPromise(
				setOrganizationSharingDefaults("alice", "org-a", defaults),
			),
		).resolves.toEqual(defaults);
		expect(metadata).toMatchObject({
			zuse_creator: "alice",
			unrelated: "keep",
		});
		await expect(
			runtime.runPromise(getOrganizationSharingDefaults("org-a")),
		).resolves.toEqual(defaults);
		metadata.zuse_chat_sharing = "invalid";
		await expect(
			runtime.runPromise(getOrganizationSharingDefaults("org-a")),
		).rejects.toMatchObject({ code: "organization_sharing_defaults_invalid" });
	});

	it("validates chat grants against active content memberships in the same organization", async () => {
		await runtime.runPromise(
			validateOrganizationChatGrants("org-a", ["owner", "driver"]),
		);
		for (const invalid of [
			["other"],
			["missing"],
			["driver", "driver"],
			Array.from({ length: 6 }, (_, index) => `member-${index}`),
		]) {
			await expect(
				runtime.runPromise(validateOrganizationChatGrants("org-a", invalid)),
			).rejects.toMatchObject({ code: "invalid_chat_grants" });
		}
		members = [
			member("finance", "bob", "org-a", "billing"),
			{ ...member("inactive", "carol", "org-a"), status: "inactive" },
		];
		for (const id of ["finance", "inactive"]) {
			await expect(
				runtime.runPromise(validateOrganizationChatGrants("org-a", [id])),
			).rejects.toMatchObject({ code: "invalid_chat_grants" });
		}
		provider.mockRejectedValue(new Error("offline"));
		await expect(
			runtime.runPromise(validateOrganizationChatGrants("org-a", ["driver"])),
		).rejects.toMatchObject({ code: "organizations_unavailable" });
	});

	it("lists only current memberships, irrespective of the token's selected organization", async () => {
		const response = await call("", "bob");
		expect(await response?.json()).toEqual([
			{ id: "org-a", name: "Acme", role: "member", isCreator: false },
		]);
		for (const member of members)
			if (member.user_id === "bob") member.status = "inactive";
		expect(await (await call("", "bob"))?.json()).toEqual([]);
	});
	it("denies cross-organization reads before requesting the roster", async () => {
		await expect(
			call("/details", "eve", { organizationId: "org-a" }),
		).rejects.toMatchObject({ status: 403 });
		expect(provider).toHaveBeenCalledTimes(1);
	});
	it("does not expose the deferred shared-host authorization endpoint", async () => {
		await expect(
			call("/authorize", "alice", { organizationId: "org-a", subject: "bob" }),
		).rejects.toMatchObject({ status: 404 });
		expect(provider).not.toHaveBeenCalled();
	});
	it("counts an existing created organization, not an invited admin membership", async () => {
		const fallback = provider.getMockImplementation();
		provider.mockImplementation(async (input, init) => {
			const path = new URL(input).pathname;
			if (path.startsWith("/organizations/external_id/"))
				return Response.json({}, { status: 404 });
			if (path === "/organizations/org-a")
				return Response.json({
					id: "org-a",
					name: "Existing",
					metadata: { zuse_creator: "alice" },
				});
			if (!fallback) throw new Error("Missing provider fixture");
			return fallback(input, init);
		});
		await expect(
			call("", "alice", {
				name: "Second",
				operationId: "894fe47d-0f8d-4a87-b1aa-76692b1c5f07",
			}),
		).rejects.toMatchObject({ code: "organization_limit_reached" });
		expect(
			provider.mock.calls.some(
				([input, init]) =>
					new URL(input).pathname === "/organizations" &&
					init?.method === "POST",
			),
		).toBe(false);
	});
	it("resumes a partial organization creation without duplicating it or re-enrolling a removed admin", async () => {
		const fallback = provider.getMockImplementation();
		let organization:
			| { id: string; name: string; metadata: Record<string, string> }
			| undefined;
		let creates = 0;
		let enrollments = 0;
		let failEnrollment = true;
		provider.mockImplementation(async (input: string, init?: RequestInit) => {
			const path = new URL(input).pathname;
			const method = init?.method ?? "GET";
			const json = (value: unknown, status = 200) =>
				new Response(JSON.stringify(value), { status });
			if (path.startsWith("/organizations/external_id/"))
				return organization ? json(organization) : json({}, 404);
			if (path === "/organizations/new-org" && method === "GET")
				return json(organization);
			if (path === "/organizations" && method === "POST") {
				creates++;
				const body = JSON.parse(String(init?.body));
				organization = {
					id: "new-org",
					name: body.name,
					metadata: body.metadata,
				};
				return json(organization);
			}
			if (
				path === "/organizations/new-org" &&
				method === "PUT" &&
				organization
			) {
				organization.metadata = JSON.parse(String(init?.body)).metadata;
				return json(organization);
			}
			if (
				path === "/user_management/organization_memberships" &&
				method === "POST"
			) {
				if (failEnrollment) {
					failEnrollment = false;
					return json({}, 503);
				}
				enrollments++;
				const entry = member("new-owner", "alice", "new-org", "admin");
				members.push(entry);
				// Another admin saves defaults while creation finishes enrolling its owner.
				if (organization)
					organization.metadata.zuse_chat_sharing =
						'{"audience":"private","permission":"view"}';
				return json(entry);
			}
			if (!fallback) throw new Error("Missing provider fixture");
			return fallback(input, init);
		});
		const input = {
			name: "New team",
			operationId: "894fe47d-0f8d-4a87-b1aa-76692b1c5f07",
		};
		await expect(call("", "alice", input)).rejects.toMatchObject({
			status: 503,
		});
		const results = await Promise.allSettled([
			call("", "alice", input),
			call("", "alice", {
				...input,
				operationId: "694fe47d-0f8d-4a87-b1aa-76692b1c5f07",
			}),
		]);
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: { code: "organization_limit_reached" },
		});
		if (results[0]?.status !== "fulfilled")
			throw new Error("Creation did not recover");
		expect(await results[0].value?.json()).toEqual({
			id: "new-org",
			name: "New team",
			role: "admin",
			isCreator: true,
		});
		await call("", "alice", input);
		await expect(
			call("", "alice", {
				...input,
				operationId: "794fe47d-0f8d-4a87-b1aa-76692b1c5f07",
			}),
		).rejects.toMatchObject({
			status: 409,
			code: "organization_limit_reached",
		});
		expect(creates).toBe(1);
		expect(enrollments).toBe(1);
		expect(organization?.metadata.zuse_chat_sharing).toBe(
			'{"audience":"private","permission":"view"}',
		);
		members = members.filter((entry) => entry.id !== "new-owner");
		await expect(call("", "alice", input)).rejects.toMatchObject({
			status: 403,
		});
		expect(enrollments).toBe(1);
	});
	it.each([
		"invite",
		"revoke-invite",
		"set-role",
		"remove-member",
	])("requires a current admin for %s", async (action) => {
		await expect(
			call(`/${action}`, "bob", {
				organizationId: "org-a",
				memberId: "owner",
				invitationId: "invite",
				email: "new@example.com",
				role: "admin",
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(
			provider.mock.calls.every(([, options]) => options?.method === "GET"),
		).toBe(true);
	});
	it("checks the target member belongs to the authorized organization", async () => {
		await expect(
			call("/remove-member", "alice", {
				organizationId: "org-a",
				memberId: "other",
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(members).toHaveLength(3);
	});
	it("does not expose invitation tokens or acceptance URLs", async () => {
		const details = await (
			await call("/details", "alice", { organizationId: "org-a" })
		)?.text();
		expect(details).toContain("guest@example.com");
		expect(details).not.toContain("must-not-leak");
		expect(details).not.toContain("secret.test");
		const response = await call("/invite", "alice", {
			organizationId: "org-a",
			email: "guest@example.com",
			role: "member",
		});
		expect(await response?.json()).toEqual({
			id: "invite",
			email: "guest@example.com",
			state: "pending",
			expiresAt: "2030-01-01T00:00:00Z",
		});
	});
	it("does not disclose pending invitations to ordinary members", async () => {
		const details = await (
			await call("/details", "bob", { organizationId: "org-a" })
		)?.json();
		expect(details.invitations).toEqual([]);
		expect(
			provider.mock.calls.some(([url]) => String(url).includes("invitations")),
		).toBe(false);
	});
	it("refuses removal or demotion of the last administrator", async () => {
		await expect(
			call("/remove-member", "alice", {
				organizationId: "org-a",
				memberId: "owner",
			}),
		).rejects.toMatchObject({ code: "organization_last_admin" });
		await expect(
			call("/set-role", "alice", {
				organizationId: "org-a",
				memberId: "owner",
				role: "member",
			}),
		).rejects.toMatchObject({ code: "organization_last_admin" });
	});
	it("serializes simultaneous administrator removal and rechecks the caller", async () => {
		members.push(member("second-admin", "charlie", "org-a", "admin"));
		const outcomes = await Promise.allSettled([
			call("/remove-member", "alice", {
				organizationId: "org-a",
				memberId: "second-admin",
			}),
			call("/remove-member", "charlie", {
				organizationId: "org-a",
				memberId: "owner",
			}),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			members.filter(
				(m) => m.organization_id === "org-a" && m.role.slug === "admin",
			),
		).toHaveLength(1);
	});
	it("honors directory-managed membership", async () => {
		for (const member of members)
			if (member.user_id === "bob") member.directory_managed = true;
		await expect(
			call("/remove-member", "alice", {
				organizationId: "org-a",
				memberId: "driver",
			}),
		).rejects.toMatchObject({ status: 409 });
	});
	it("paginates memberships instead of hiding later organizations", async () => {
		provider.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({ data: [], list_metadata: { after: "next" } }),
				),
		);
		const response = await call("", "alice");
		expect(await response?.json()).toHaveLength(1);
		expect(provider.mock.calls[1]?.[0]).toContain("after=next");
	});
	it("includes the creator and pending invitations in the five-seat cap", async () => {
		members.push(member("c", "c", "org-a"), member("d", "d", "org-a"));
		await expect(
			call("/invite", "alice", {
				organizationId: "org-a",
				email: "sixth@example.com",
				role: "member",
			}),
		).rejects.toMatchObject({
			code: "organization_member_limit_reached",
			status: 409,
		});
		expect(
			provider.mock.calls.some(
				([url, init]) =>
					url.endsWith("/invitations") && init?.method === "POST",
			),
		).toBe(false);
	});
	it("serializes concurrent invitations for the final seat", async () => {
		members.push(member("c", "c", "org-a"));
		const results = await Promise.allSettled(
			["one", "two"].map((name) =>
				call("/invite", "alice", {
					organizationId: "org-a",
					email: `${name}@example.com`,
					role: "member",
				}),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.find((result) => result.status === "rejected"),
		).toMatchObject({ reason: { code: "organization_member_limit_reached" } });
	});
	it.each([
		"expired",
		"revoked",
		"accepted",
	])("does not reserve seats for %s invitations", async (state) => {
		members.push(member("c", "c", "org-a"), member("d", "d", "org-a"));
		invitations = invitations.map((invite) => ({ ...invite, state }));
		expect(
			(
				await call("/invite", "alice", {
					organizationId: "org-a",
					email: "fifth@example.com",
					role: "member",
				})
			)?.status,
		).toBe(200);
	});
	it("ignores inactive memberships and elapsed pending invitations", async () => {
		members.push(
			{ ...member("c", "c", "org-a"), status: "inactive" },
			member("d", "d", "org-a"),
			member("e", "e", "org-a"),
		);
		invitations = invitations.map((invite) => ({
			...invite,
			expires_at: "2020-01-01T00:00:00Z",
		}));
		expect(
			(
				await call("/invite", "alice", {
					organizationId: "org-a",
					email: "fifth@example.com",
					role: "member",
				})
			)?.status,
		).toBe(200);
	});
	it("rejects invalid input without issuing a provider mutation", async () => {
		await expect(
			call("/invite", "alice", {
				organizationId: "org-a",
				email: "bad",
				role: "admin",
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(provider).not.toHaveBeenCalled();
	});
	it("fails closed on provider outage and redacts provider details", async () => {
		provider.mockRejectedValue(new Error("secret-workos-key"));
		await expect(call("", "alice")).rejects.toMatchObject({
			status: 503,
			code: "organizations_unavailable",
		});
	});
	it("ignores unrelated routes", async () => {
		expect(
			await runtime.runPromise(
				routeOrganizationRequest(new Request("https://api.test/health")),
			),
		).toBeNull();
		expect(provider).not.toHaveBeenCalled();
	});
	it.each([
		"",
		"/create",
		"/invite",
		"/authorize",
	])("rejects disabled organization route %s before contacting WorkOS", async (path) => {
		const disabled = ManagedRuntime.make(
			Layer.mergeAll(
				CloudWorkspaceStoreMemory,
				ApiStoreMemory,
				WorkosVerifierTest,
				config(false),
			),
		);
		try {
			await expect(
				disabled.runPromise(
					routeOrganizationRequest(
						new Request(`https://api.test/v1/organizations${path}`, {
							method: "POST",
							headers: { authorization: "Bearer test-token:alice" },
						}),
					),
				),
			).rejects.toMatchObject({ code: "organization_workspaces_disabled" });
			expect(provider).not.toHaveBeenCalled();
		} finally {
			await disabled.dispose();
		}
	});
});
