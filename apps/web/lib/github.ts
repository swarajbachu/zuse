import "server-only";

const REPOSITORY_API_URL = "https://api.github.com/repos/swarajbachu/zuse";

export async function getGitHubStars(): Promise<number | null> {
	try {
		const response = await fetch(REPOSITORY_API_URL, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "zuse-web",
			},
			// This fetch sets the ISR interval for pages using the shared layout.
			// Refresh the decorative star count daily to avoid hourly page rewrites.
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
