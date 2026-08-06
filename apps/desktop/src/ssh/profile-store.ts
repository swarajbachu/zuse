import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	RemoteEnvironmentProfile,
	type SshEnvironmentTarget,
} from "@zuse/contracts";
import { Schema } from "effect";

const PROFILE_FILE = "remote-environments.json";

const ProfileDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	profiles: Schema.Array(RemoteEnvironmentProfile),
});

type ProfileDocument = typeof ProfileDocument.Type;

const decodeProfiles = (
	raw: string,
): ReadonlyArray<RemoteEnvironmentProfile> => {
	const parsed: unknown = JSON.parse(raw);
	// Early development builds wrote the profile array directly. Accept it once
	// and rewrite it in the current versioned envelope on the next mutation.
	if (Array.isArray(parsed)) {
		return Schema.decodeUnknownSync(Schema.Array(RemoteEnvironmentProfile))(
			parsed,
		);
	}
	return Schema.decodeUnknownSync(ProfileDocument)(parsed).profiles;
};

const filePath = (userData: string): string => join(userData, PROFILE_FILE);

export class RemoteEnvironmentProfileStore {
	private profiles = new Map<string, RemoteEnvironmentProfile>();
	private writeTail = Promise.resolve();

	constructor(private readonly userData: string) {}

	async load(): Promise<ReadonlyArray<RemoteEnvironmentProfile>> {
		let raw: string;
		const path = filePath(this.userData);
		try {
			raw = await readFile(path, "utf8");
		} catch (cause) {
			if (
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT"
			) {
				this.profiles.clear();
				return [];
			}
			throw cause;
		}
		await chmod(path, 0o600);
		try {
			const profiles = decodeProfiles(raw);
			this.profiles = new Map(
				profiles.map((profile) => [profile.profileId, profile]),
			);
		} catch {
			this.profiles.clear();
		}
		return this.list();
	}

	list(): ReadonlyArray<RemoteEnvironmentProfile> {
		return [...this.profiles.values()].sort((left, right) =>
			left.label.localeCompare(right.label),
		);
	}

	get(profileId: string): RemoteEnvironmentProfile | null {
		return this.profiles.get(profileId) ?? null;
	}

	findByTarget(target: SshEnvironmentTarget): RemoteEnvironmentProfile | null {
		return (
			this.list().find(
				(profile) =>
					profile.target.hostname === target.hostname &&
					profile.target.username === target.username &&
					profile.target.port === target.port,
			) ?? null
		);
	}

	async put(profile: RemoteEnvironmentProfile): Promise<void> {
		await this.mutate(() => this.profiles.set(profile.profileId, profile));
	}

	async remove(profileId: string): Promise<void> {
		await this.mutate(() => this.profiles.delete(profileId));
	}

	private mutate(update: () => void): Promise<void> {
		const operation = this.writeTail.then(async () => {
			const previous = new Map(this.profiles);
			update();
			try {
				await this.persist();
			} catch (cause) {
				this.profiles = previous;
				throw cause;
			}
		});
		this.writeTail = operation.catch(() => undefined);
		return operation;
	}

	private async persist(): Promise<void> {
		await mkdir(this.userData, { recursive: true, mode: 0o700 });
		const destination = filePath(this.userData);
		const temporary = `${destination}.${process.pid}.tmp`;
		const document: ProfileDocument = {
			schemaVersion: 1,
			profiles: this.list(),
		};
		await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}
}
