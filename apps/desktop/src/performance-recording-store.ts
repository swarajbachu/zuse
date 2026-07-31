import {
	mkdir,
	readdir,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export interface PerformanceRecordingStoreOptions {
	readonly directory: string;
	readonly retentionMs?: number;
	readonly maxBytes?: number;
	readonly now?: () => number;
}

export class PerformanceRecordingStore {
	private readonly retentionMs: number;
	private readonly maxBytes: number;
	private readonly now: () => number;

	constructor(private readonly options: PerformanceRecordingStoreOptions) {
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.now = options.now ?? Date.now;
	}

	async save(id: string, report: unknown): Promise<string> {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
			throw new TypeError("Invalid performance recording id.");
		}
		await mkdir(this.options.directory, { recursive: true });
		const target = join(this.options.directory, `${id}.json`);
		const temporary = join(this.options.directory, `.${id}.tmp`);
		await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		await rename(temporary, target);
		await this.prune();
		return target;
	}

	async prune(): Promise<void> {
		await mkdir(this.options.directory, { recursive: true });
		const files = await readdir(this.options.directory);
		const records = (
			await Promise.all(
				files
					.filter((file) => file.endsWith(".json"))
					.map(async (file) => {
						const path = join(this.options.directory, file);
						return { path, stat: await stat(path) };
					}),
			)
		).sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
		const cutoff = this.now() - this.retentionMs;
		for (const record of [...records]) {
			if (record.stat.mtimeMs >= cutoff) continue;
			await unlink(record.path).catch(() => undefined);
			records.splice(records.indexOf(record), 1);
		}
		let total = records.reduce((sum, record) => sum + record.stat.size, 0);
		for (const record of records) {
			if (total <= this.maxBytes) break;
			await unlink(record.path).catch(() => undefined);
			total -= record.stat.size;
		}
	}
}
