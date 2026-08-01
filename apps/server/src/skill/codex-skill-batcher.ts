type SkillListEntry<Skill> = {
	readonly cwd: string;
	readonly skills: ReadonlyArray<Skill>;
};

type WaitingRequest<Skill> = {
	readonly resolve: (skills: ReadonlyArray<Skill>) => void;
	readonly reject: (cause: unknown) => void;
};

export interface CodexSkillBatcher<Skill> {
	readonly load: (cwd: string) => Promise<ReadonlyArray<Skill>>;
}

/** Batches adjacent project hydration into one provider-native skills read. */
export const createCodexSkillBatcher = <Skill>(
	list: (
		cwds: ReadonlyArray<string>,
	) => Promise<ReadonlyArray<SkillListEntry<Skill>>>,
	delayMs: number,
): CodexSkillBatcher<Skill> => {
	const waiting = new Map<string, Array<WaitingRequest<Skill>>>();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = async (): Promise<void> => {
		timer = null;
		const batch = new Map(waiting);
		waiting.clear();
		try {
			const entries = await list([...batch.keys()]);
			const byCwd = new Map(entries.map((entry) => [entry.cwd, entry.skills]));
			for (const [cwd, requests] of batch) {
				const skills = byCwd.get(cwd) ?? [];
				for (const request of requests) request.resolve(skills);
			}
		} catch (cause) {
			for (const requests of batch.values()) {
				for (const request of requests) request.reject(cause);
			}
		}
	};

	return {
		load: (cwd) =>
			new Promise((resolve, reject) => {
				const requests = waiting.get(cwd) ?? [];
				requests.push({ resolve, reject });
				waiting.set(cwd, requests);
				if (timer === null) timer = setTimeout(() => void flush(), delayMs);
			}),
	};
};
