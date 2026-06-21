import { NextResponse } from "next/server";

import { GITHUB_URL } from "@/lib/site";

const RELEASE_API_URL =
  "https://api.github.com/repos/swarajbachu/memoize/releases/latest";

type GitHubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GitHubRelease = {
  assets?: unknown;
};

const FALLBACK_URL = `${GITHUB_URL}/releases`;

export async function GET() {
  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      return NextResponse.redirect(FALLBACK_URL);
    }

    const release = (await response.json()) as GitHubRelease;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const dmg = assets.find((asset): asset is GitHubReleaseAsset => {
      if (asset === null || typeof asset !== "object") return false;

      const { name, browser_download_url } = asset as GitHubReleaseAsset;
      return (
        typeof name === "string" &&
        typeof browser_download_url === "string" &&
        name.endsWith(".dmg") &&
        !name.endsWith(".dmg.blockmap")
      );
    });

    if (typeof dmg?.browser_download_url === "string") {
      return NextResponse.redirect(dmg.browser_download_url);
    }
  } catch {
    // Fall through to the public releases page.
  }

  return NextResponse.redirect(FALLBACK_URL);
}
