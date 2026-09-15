import { expect, test } from "vitest";
import { checkAvatarKey, parsePrAvatars } from "../../src/pr-avatars.ts";

test("uses GitHub app logos and keys similarly named checks by URL", () => {
	const pages = [1, 2].map((id) => ({
		data: {
			repository: {
				pullRequest: {
					author: { avatarUrl: "https://avatars.githubusercontent.com/u/1" },
				},
				object: {
					statusCheckRollup: {
						contexts: {
							nodes: [
								{
									name: "Review",
									detailsUrl: `https://github.com/checks/${id}`,
									checkSuite: {
										app: {
											name: `App ${id}`,
											logoUrl: `https://avatars.githubusercontent.com/in/${id}`,
										},
									},
								},
							],
						},
					},
				},
			},
		},
	}));
	const result = parsePrAvatars(JSON.stringify(pages));
	expect(result.authorAvatarUrl).toBe(
		"https://avatars.githubusercontent.com/u/1",
	);
	expect(result.checks.size).toBe(2);
	expect(
		result.checks.get(checkAvatarKey("Review", "https://github.com/checks/2")),
	).toEqual({
		name: "App 2",
		avatarUrl: "https://avatars.githubusercontent.com/in/2",
	});
});

test("missing artwork does not invent a GitHub user avatar", () => {
	expect(parsePrAvatars("permission denied").checks.size).toBe(0);
	expect(parsePrAvatars("[{}]").authorAvatarUrl).toBeNull();
});
