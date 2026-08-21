import "server-only";

const REPOSITORY_API_URL = "https://api.github.com/repos/swarajbachu/zuse";

export async function getGitHubStars(): Promise<number | null> {
	try {
		const response = await fetch(REPOSITORY_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "zuse-docs",
			},
			next: { revalidate: 3600 },
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
