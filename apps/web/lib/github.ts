import "server-only";

import { GITHUB_API_URL } from "@/lib/site";

export async function getGitHubStars(): Promise<number | null> {
	try {
		const response = await fetch(GITHUB_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "zuse-web",
			},

			next: { revalidate: 86400 },
		});
		if (!response.ok) return null;

		const repository: unknown = await response.json();
		if (
			typeof repository !== "object" ||
			repository === null ||
			!("stargazers_count" in repository) ||
			typeof repository.stargazers_count !== "number"
		) {
			return null;
		}

		return repository.stargazers_count;
	} catch {
		return null;
	}
}
