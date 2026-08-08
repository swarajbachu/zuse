import {
	RemoteEnvironmentProfile,
	type SshEnvironmentTarget,
} from "@zuse/contracts";
import { Schema } from "effect";

import { AtomicProfileStore } from "../profile-store.ts";

export class RemoteEnvironmentProfileStore {
	private readonly store: AtomicProfileStore<RemoteEnvironmentProfile>;

	constructor(userData: string) {
		this.store = new AtomicProfileStore(userData, {
			fileName: "remote-environments.json",
			decode: Schema.decodeUnknownSync(RemoteEnvironmentProfile),
			// Early builds wrote the profile array directly. Accept it and rewrite
			// the versioned envelope on the next mutation.
			decodeLegacy: (value) =>
				Array.isArray(value)
					? Schema.decodeUnknownSync(Schema.Array(RemoteEnvironmentProfile))(
							value,
						)
					: null,
		});
	}

	async load(): Promise<ReadonlyArray<RemoteEnvironmentProfile>> {
		return this.store.load();
	}

	list(): ReadonlyArray<RemoteEnvironmentProfile> {
		return this.store.list();
	}

	get(profileId: string): RemoteEnvironmentProfile | null {
		return this.store.get(profileId);
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
		await this.store.put(profile);
	}

	async remove(profileId: string): Promise<void> {
		await this.store.remove(profileId);
	}
}
