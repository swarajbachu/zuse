import { Schema } from "effect";

import { EnvironmentDescriptor } from "./connect.ts";
import { EnvironmentId } from "./ids.ts";

export const SshHostSource = Schema.Literals(["ssh-config", "tailscale"]);
export type SshHostSource = typeof SshHostSource.Type;

const HostAlias = Schema.String.check(
	Schema.isMinLength(1),
	Schema.makeFilter((value) =>
		/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/u.test(value)
			? undefined
			: "SSH host contains unsupported characters.",
	),
);
const Username = Schema.String.check(
	Schema.isMinLength(1),
	Schema.makeFilter((value) =>
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
			? undefined
			: "SSH username contains unsupported characters.",
	),
);
const Port = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value) =>
		value >= 1 && value <= 65_535
			? undefined
			: "SSH port must be between 1 and 65535.",
	),
);

export class SshEnvironmentTarget extends Schema.Class<SshEnvironmentTarget>(
	"SshEnvironmentTarget",
)({
	alias: HostAlias,
	hostname: Schema.String.check(Schema.isMinLength(1)),
	username: Schema.NullOr(Username),
	port: Schema.NullOr(Port),
}) {}

export class DiscoveredSshHost extends Schema.Class<DiscoveredSshHost>(
	"DiscoveredSshHost",
)({
	alias: Schema.String,
	hostname: Schema.String,
	username: Schema.NullOr(Schema.String),
	port: Schema.NullOr(Schema.Number),
	source: SshHostSource,
	online: Schema.NullOr(Schema.Boolean),
	os: Schema.NullOr(Schema.String),
	displayName: Schema.String,
}) {}

export class RemoteEnvironmentProfile extends Schema.Class<RemoteEnvironmentProfile>(
	"RemoteEnvironmentProfile",
)({
	profileId: Schema.String,
	environmentId: EnvironmentId,
	label: Schema.String,
	target: SshEnvironmentTarget,
	lastConnectedAt: Schema.String,
}) {}

export class SshEnvironmentConnection extends Schema.Class<SshEnvironmentConnection>(
	"SshEnvironmentConnection",
)({
	profile: RemoteEnvironmentProfile,
	descriptor: EnvironmentDescriptor,
}) {}

export const EnsureSshEnvironmentInput = Schema.Union([
	Schema.Struct({ profileId: Schema.String }),
	Schema.Struct({
		target: SshEnvironmentTarget,
		label: Schema.optional(Schema.String),
	}),
]);
export type EnsureSshEnvironmentInput = typeof EnsureSshEnvironmentInput.Type;
