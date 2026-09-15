import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	throw new Error(
		"Native iOS compile/link verification requires macOS with Xcode",
	);
}

const repository = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const ios = path.join(repository, "apps/mobile/ios");
const derivedData = mkdtempSync(path.join(tmpdir(), "zuse-ios-derived-data-"));

function run(command, arguments_, options = {}) {
	execFileSync(command, arguments_, { stdio: "inherit", ...options });
}

function capture(command, arguments_, options = {}) {
	return execFileSync(command, arguments_, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		...options,
	});
}

function runtimeVersion(runtime) {
	const suffix = runtime.split(".iOS-")[1] ?? "0";
	return suffix.split("-").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionsDescending(left, right) {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (right[index] ?? 0) - (left[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function availableSimulator() {
	const listing = JSON.parse(
		capture("xcrun", ["simctl", "list", "devices", "available", "--json"]),
	);
	const candidates = Object.entries(listing.devices ?? {})
		.filter(([runtime]) => runtime.includes(".iOS-"))
		.flatMap(([runtime, devices]) =>
			devices
				.filter(
					(device) =>
						device.isAvailable !== false &&
						(device.name?.startsWith("iPhone") ?? false),
				)
				.map((device) => ({ ...device, runtime })),
		)
		.sort((left, right) => {
			if (left.state === "Booted" && right.state !== "Booted") return -1;
			if (right.state === "Booted" && left.state !== "Booted") return 1;
			return compareVersionsDescending(
				runtimeVersion(left.runtime),
				runtimeVersion(right.runtime),
			);
		});
	if (candidates.length === 0) {
		throw new Error(
			"No available iPhone simulator runtime is installed in Xcode",
		);
	}
	return candidates[0];
}

let bootedByScript = false;
let simulator;
try {
	if (process.argv.includes("--rebuild-ghostty")) {
		run(process.execPath, [
			path.join(repository, "scripts/build-ghostty-ios.mjs"),
		]);
	}
	run(process.execPath, [
		"--test",
		path.join(repository, "scripts/check-ghostty-ios.test.mjs"),
	]);
	run("pod", ["install", "--deployment", `--project-directory=${ios}`], {
		cwd: repository,
	});
	simulator = availableSimulator();
	if (simulator.state !== "Booted") {
		run("xcrun", ["simctl", "boot", simulator.udid]);
		bootedByScript = true;
		run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
	}
	run(
		"xcodebuild",
		[
			"-workspace",
			path.join(ios, "ZuseMobile.xcworkspace"),
			"-scheme",
			"ZuseMobile",
			"-configuration",
			"Debug",
			"-destination",
			`platform=iOS Simulator,id=${simulator.udid}`,
			"-derivedDataPath",
			derivedData,
			"-only-testing:ZuseMobileTests",
			"CODE_SIGNING_ALLOWED=NO",
			"test",
		],
		{ cwd: repository },
	);
	console.log(
		`Ghostty iOS compile, simulator link, and XCTest passed on ${simulator.name} (${simulator.runtime}).`,
	);
} finally {
	if (bootedByScript && simulator) {
		try {
			run("xcrun", ["simctl", "shutdown", simulator.udid]);
		} catch {
			// Preserve the original build/test failure if simulator cleanup also fails.
		}
	}
	rmSync(derivedData, { recursive: true, force: true });
}
