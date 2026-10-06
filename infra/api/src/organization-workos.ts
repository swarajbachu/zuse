import {
	ORGANIZATION_MEMBER_LIMIT,
	OrganizationInvitation,
} from "@zuse/contracts";
import { Clock, Effect, Redacted, Schema } from "effect";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	conflict,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { ApiStore } from "./store.ts";
export const WorkosOrganization = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const WorkosMember = Schema.Struct({
	id: Schema.String,
	user_id: Schema.String,
	organization_id: Schema.String,
	status: Schema.String,
	role: Schema.Struct({ slug: Schema.String }),
	directory_managed: Schema.optional(Schema.Boolean),
});
export const WorkosInvitation = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	organization_id: Schema.NullOr(Schema.String),
	state: OrganizationInvitation.fields.state,
	expires_at: Schema.String,
});
export const WorkosUser = Schema.Struct({
	email: Schema.String,
	email_verified: Schema.optional(Schema.Boolean),
	profile_picture_url: Schema.optional(Schema.NullOr(Schema.String)),
	first_name: Schema.NullOr(Schema.String),
	last_name: Schema.NullOr(Schema.String),
});

/** Server-only WorkOS access. Provider bodies and invitation tokens never leave this boundary. */
export const requestWorkos = <A, I>(
	path: string,
	schema: Schema.Codec<A, I>,
	method = "GET",
	body?: unknown,
) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		const apiKey = config.workosApiKey;
		if (apiKey === undefined)
			return yield* serviceUnavailable("organizations_not_configured");
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(`https://api.workos.com${path}`, {
					method,
					headers: {
						authorization: `Bearer ${Redacted.value(apiKey)}`,
						"content-type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
				}),
			catch: () => serviceUnavailable("organizations_unavailable"),
		});
		if (!response.ok) {
			if (response.status === 404)
				return yield* notFound("organization_resource_not_found");
			if (response.status === 409)
				return yield* conflict("organization_conflict");
			if (response.status === 400 || response.status === 422)
				return yield* badRequest("organization_invalid_request");
			return yield* serviceUnavailable("organizations_unavailable");
		}
		const payload =
			response.status === 204
				? null
				: yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => serviceUnavailable("organizations_invalid_response"),
					});
		return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
			Effect.mapError(() =>
				serviceUnavailable("organizations_invalid_response"),
			),
		);
	});

/** Follow provider cursors; never silently authorize against a truncated roster. */
export const listWorkos = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const rows: A[] = [];
		let after: string | null = null;
		const cursors = new Set<string>();
		do {
			const query: string = `${path}${path.includes("?") ? "&" : "?"}limit=100${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
			const page: {
				readonly data: ReadonlyArray<A>;
				readonly list_metadata: { readonly after: string | null };
			} = yield* requestWorkos(
				query,
				Schema.Struct({
					data: Schema.Array(schema),
					list_metadata: Schema.Struct({ after: Schema.NullOr(Schema.String) }),
				}),
			);
			rows.push(...page.data);
			after = page.list_metadata.after;
			if (after !== null) {
				if (cursors.has(after) || cursors.size >= 100)
					return yield* serviceUnavailable("organization_roster_too_large");
				cursors.add(after);
			}
		} while (after !== null);
		return rows;
	});

export const reservesSeat = (
	invite: typeof WorkosInvitation.Type,
	organizationId: string,
	now: number,
) =>
	invite.organization_id === organizationId &&
	invite.state === "pending" &&
	!(Date.parse(invite.expires_at) <= now);

export const organizationSeatsFull = Effect.fn("organizationSeatsFull")(
	function* (organizationId: string, joiningAccountId?: string) {
		const invites = yield* listWorkos(
			`/user_management/invitations?organization_id=${encodeURIComponent(organizationId)}`,
			WorkosInvitation,
		);
		const roster = yield* listWorkos(
			`/user_management/organization_memberships?organization_id=${encodeURIComponent(organizationId)}`,
			WorkosMember,
		);
		const now = yield* Clock.currentTimeMillis;
		const active = new Set(
			roster
				.filter(
					(m) => m.organization_id === organizationId && m.status === "active",
				)
				.map((m) => m.user_id),
		);
		const pending = (yield* (yield* ApiStore).githubJoining.listEnrollments(
			organizationId,
		)).filter(
			(e) =>
				!e.blocked &&
				e.accountId !== joiningAccountId &&
				!active.has(e.accountId) &&
				e.reservedUntil > now,
		).length;
		return (
			active.size +
				pending +
				invites.filter((i) => reservesSeat(i, organizationId, now)).length >=
			ORGANIZATION_MEMBER_LIMIT
		);
	},
);

/**
 * Admit an account as Member for automatic joining. Reactivates the account's
 * previous self-joined membership instead of creating a duplicate. Callers hold
 * the organization lock and have already checked eligibility and capacity.
 */
export const admitOrganizationMember = (
	organizationId: string,
	accountId: string,
	memberships: ReadonlyArray<typeof WorkosMember.Type>,
) => {
	const previous = memberships.find(
		(m) =>
			m.status === "inactive" &&
			!m.directory_managed &&
			m.role.slug === "member",
	);
	return previous
		? requestWorkos(
				`/user_management/organization_memberships/${encodeURIComponent(previous.id)}/reactivate`,
				WorkosMember,
				"PUT",
				{},
			)
		: requestWorkos(
				"/user_management/organization_memberships",
				WorkosMember,
				"POST",
				{
					organization_id: organizationId,
					user_id: accountId,
					role_slug: "member",
				},
			);
};

/** An account's memberships in one organization. */
export const membershipsFor = (accountId: string, organizationId: string) =>
	listWorkos(
		`/user_management/organization_memberships?organization_id=${encodeURIComponent(organizationId)}&user_id=${encodeURIComponent(accountId)}`,
		WorkosMember,
	).pipe(
		Effect.map((rows) =>
			rows.filter(
				(m) => m.organization_id === organizationId && m.user_id === accountId,
			),
		),
	);
