import type { UpdateChannel } from "@zuse/contracts";
import {
	compareReleaseVersions,
	parseReleaseVersion,
} from "@zuse/utils/release-version";
import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";

type GitHubOptions = ConstructorParameters<typeof GitHubProvider>[0];
type RuntimeOptions = ConstructorParameters<typeof GitHubProvider>[2];

/** Custom GitHub channels exclude Stable upstream. Compare the two feeds explicitly. */
export function channelProvider(
	options: GitHubOptions,
	getChannel: () => UpdateChannel,
): new (
	options: unknown,
	updater: AppUpdater,
	runtime: RuntimeOptions,
) => GitHubProvider {
	return class ChannelProvider extends GitHubProvider {
		constructor(
			_options: unknown,
			private readonly appUpdater: AppUpdater,
			runtime: RuntimeOptions,
		) {
			super(options, appUpdater, runtime);
		}

		override async getLatestVersion() {
			const updater = this.appUpdater;
			const previous = {
				channel: updater.channel ?? "latest",
				prerelease: updater.allowPrerelease,
				downgrade: updater.allowDowngrade,
			};
			try {
				updater.channel = "latest";
				updater.allowPrerelease = false;
				const stable = await super.getLatestVersion();
				if (parseReleaseVersion(stable.version).preview !== null)
					throw new Error("Stable feed contains a prerelease");
				if (getChannel() === "stable") return stable;
				updater.channel = "preview";
				updater.allowPrerelease = true;
				try {
					const preview = await super.getLatestVersion();
					if (parseReleaseVersion(preview.version).preview === null)
						throw new Error("Preview feed contains an invalid version");
					return compareReleaseVersions(preview.version, stable.version) > 0
						? preview
						: stable;
				} catch (error) {
					// A fresh rollout may not have published any Preview builds yet.
					if (
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS"
					)
						return stable;
					throw error;
				}
			} finally {
				updater.channel = previous.channel;
				updater.allowPrerelease = previous.prerelease;
				updater.allowDowngrade = previous.downgrade;
			}
		}
	};
}
