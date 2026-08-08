import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

type StoredProfile = {
	readonly profileId: string;
	readonly label: string;
};

type ProfileStoreOptions<Profile extends StoredProfile> = {
	readonly fileName: string;
	readonly decode: (value: unknown) => Profile;
	readonly decodeLegacy?: (value: unknown) => ReadonlyArray<Profile> | null;
};

/**
 * Durable, schema-checked profile persistence shared by remote transports.
 *
 * The interface deliberately owns write serialization, rollback, atomic
 * replacement, permissions, corruption recovery, and deterministic ordering.
 * Transport adapters only supply their profile schema and file name.
 */
export class AtomicProfileStore<Profile extends StoredProfile> {
	private profiles = new Map<string, Profile>();
	private writeTail = Promise.resolve();

	constructor(
		private readonly userData: string,
		private readonly options: ProfileStoreOptions<Profile>,
	) {}

	async load(): Promise<ReadonlyArray<Profile>> {
		const path = this.filePath();
		let raw: string;
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
			const parsed: unknown = JSON.parse(raw);
			const legacy = this.options.decodeLegacy?.(parsed) ?? null;
			const profiles =
				legacy ??
				(() => {
					if (
						typeof parsed !== "object" ||
						parsed === null ||
						!("schemaVersion" in parsed) ||
						parsed.schemaVersion !== 1 ||
						!("profiles" in parsed) ||
						!Array.isArray(parsed.profiles)
					) {
						throw new Error("Invalid profile document");
					}
					return parsed.profiles.map(this.options.decode);
				})();
			this.profiles = new Map(
				profiles.map((profile) => [profile.profileId, profile]),
			);
		} catch {
			this.profiles.clear();
		}
		return this.list();
	}

	list(): ReadonlyArray<Profile> {
		return [...this.profiles.values()].sort((left, right) =>
			left.label.localeCompare(right.label),
		);
	}

	get(profileId: string): Profile | null {
		return this.profiles.get(profileId) ?? null;
	}

	async put(profile: Profile): Promise<void> {
		await this.mutate(() => this.profiles.set(profile.profileId, profile));
	}

	async remove(profileId: string): Promise<void> {
		await this.mutate(() => this.profiles.delete(profileId));
	}

	private filePath(): string {
		return join(this.userData, this.options.fileName);
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
		const destination = this.filePath();
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ schemaVersion: 1, profiles: this.list() }, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		try {
			await rename(temporary, destination);
			await chmod(destination, 0o600);
		} finally {
			await rm(temporary, { force: true });
		}
	}
}
