import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { TailnetEnvironmentProfile } from "@zuse/contracts";
import { Schema } from "effect";

const PROFILE_FILE = "tailnet-environments.json";
const ProfileDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	profiles: Schema.Array(TailnetEnvironmentProfile),
});
type ProfileDocument = typeof ProfileDocument.Type;

const filePath = (userData: string): string => join(userData, PROFILE_FILE);

export class TailnetEnvironmentProfileStore {
	private profiles = new Map<string, TailnetEnvironmentProfile>();
	private writeTail = Promise.resolve();

	constructor(private readonly userData: string) {}

	async load(): Promise<ReadonlyArray<TailnetEnvironmentProfile>> {
		const path = filePath(this.userData);
		try {
			const raw = await readFile(path, "utf8");
			await chmod(path, 0o600);
			const decoded = Schema.decodeUnknownSync(ProfileDocument)(
				JSON.parse(raw),
			);
			this.profiles = new Map(
				decoded.profiles.map((profile) => [profile.profileId, profile]),
			);
		} catch (cause) {
			if (
				typeof cause !== "object" ||
				cause === null ||
				!("code" in cause) ||
				cause.code !== "ENOENT"
			) {
				this.profiles.clear();
			}
		}
		return this.list();
	}

	list(): ReadonlyArray<TailnetEnvironmentProfile> {
		return [...this.profiles.values()].sort((left, right) =>
			left.label.localeCompare(right.label),
		);
	}

	get(profileId: string): TailnetEnvironmentProfile | null {
		return this.profiles.get(profileId) ?? null;
	}

	async put(profile: TailnetEnvironmentProfile): Promise<void> {
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
