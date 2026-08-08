import { TailnetEnvironmentProfile } from "@zuse/contracts";
import { Schema } from "effect";

import { AtomicProfileStore } from "../profile-store.ts";

export class TailnetEnvironmentProfileStore {
	private readonly store: AtomicProfileStore<TailnetEnvironmentProfile>;

	constructor(userData: string) {
		this.store = new AtomicProfileStore(userData, {
			fileName: "tailnet-environments.json",
			decode: Schema.decodeUnknownSync(TailnetEnvironmentProfile),
		});
	}

	async load(): Promise<ReadonlyArray<TailnetEnvironmentProfile>> {
		return this.store.load();
	}

	list(): ReadonlyArray<TailnetEnvironmentProfile> {
		return this.store.list();
	}

	get(profileId: string): TailnetEnvironmentProfile | null {
		return this.store.get(profileId);
	}

	async put(profile: TailnetEnvironmentProfile): Promise<void> {
		await this.store.put(profile);
	}

	async remove(profileId: string): Promise<void> {
		await this.store.remove(profileId);
	}
}
