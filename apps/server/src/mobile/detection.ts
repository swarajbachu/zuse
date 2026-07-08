import { promises as fs } from "node:fs";
import path from "node:path";

import { MobileDevice, MobileProjectDetection } from "@zuse/wire";

type PackageJson = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};

const hasDep = (pkg: PackageJson | null, name: string): boolean => {
  if (pkg === null) return false;
  return (
    Object.hasOwn(pkg.dependencies ?? {}, name) ||
    Object.hasOwn(pkg.devDependencies ?? {}, name)
  );
};

const hasExpoConfig = (entries: ReadonlySet<string>): boolean =>
  entries.has("app.json") ||
  entries.has("app.config.js") ||
  entries.has("app.config.ts") ||
  entries.has("app.config.mjs");

export const detectFromFiles = (
  entries: ReadonlyArray<string>,
  packageJson: PackageJson | null,
): MobileProjectDetection => {
  const names = new Set(entries);
  const hasIosDir = names.has("ios");
  const xcode = entries.find(
    (entry) => entry.endsWith(".xcworkspace") || entry.endsWith(".xcodeproj"),
  );

  if (hasExpoConfig(names) || hasDep(packageJson, "expo")) {
    const detail =
      hasIosDir || hasDep(packageJson, "expo-dev-client")
        ? "npx expo run:ios"
        : "npx expo start --ios";
    return MobileProjectDetection.make({ type: "expo", detail });
  }

  if (hasDep(packageJson, "react-native") && hasIosDir) {
    return MobileProjectDetection.make({
      type: "react-native",
      detail: "npx react-native run-ios",
    });
  }

  if (xcode !== undefined) {
    return MobileProjectDetection.make({ type: "xcode", detail: xcode });
  }

  return MobileProjectDetection.make({ type: "none" });
};

export const detectProjectAtPath = async (
  cwd: string,
): Promise<MobileProjectDetection> => {
  let entries: string[];
  try {
    entries = await fs.readdir(cwd);
  } catch {
    return MobileProjectDetection.make({ type: "none" });
  }

  let packageJson: PackageJson | null = null;
  try {
    packageJson = JSON.parse(
      await fs.readFile(path.join(cwd, "package.json"), "utf8"),
    ) as PackageJson;
  } catch {
    packageJson = null;
  }

  return detectFromFiles(entries, packageJson);
};

type RawSimctlDevice = {
  readonly udid?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly isAvailable?: unknown;
};

const runtimeLabel = (runtimeId: string): string => {
  const match = runtimeId.match(/SimRuntime\.([A-Za-z]+)-(.+)$/);
  if (match === null) return runtimeId;
  return `${match[1]!} ${match[2]!.replace(/-/g, ".")}`;
};

export const parseSimctlDevices = (json: string): ReadonlyArray<MobileDevice> => {
  const parsed = JSON.parse(json) as {
    readonly devices?: Record<string, ReadonlyArray<RawSimctlDevice>>;
  };
  const out: MobileDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices) {
      if (
        typeof device.udid !== "string" ||
        typeof device.name !== "string" ||
        device.isAvailable !== true
      ) {
        continue;
      }
      out.push(
        MobileDevice.make({
          udid: device.udid,
          name: device.name,
          runtime: runtimeLabel(runtime),
          state: device.state === "Booted" ? "Booted" : "Shutdown",
          isAvailable: true,
        }),
      );
    }
  }
  return out.sort((a, b) => {
    const aBoot = a.state === "Booted" ? 0 : 1;
    const bBoot = b.state === "Booted" ? 0 : 1;
    if (aBoot !== bBoot) return aBoot - bBoot;
    const aPhone = a.name.includes("iPhone") ? 0 : 1;
    const bPhone = b.name.includes("iPhone") ? 0 : 1;
    if (aPhone !== bPhone) return aPhone - bPhone;
    return a.name.localeCompare(b.name);
  });
};

export const buildXcodebuildArgs = (input: {
  readonly kind: "workspace" | "project";
  readonly path: string;
  readonly scheme: string;
  readonly udid: string;
  readonly derivedDataPath: string;
}): ReadonlyArray<string> => [
  input.kind === "workspace" ? "-workspace" : "-project",
  input.path,
  "-scheme",
  input.scheme,
  "-configuration",
  "Debug",
  "-destination",
  `platform=iOS Simulator,id=${input.udid}`,
  "-derivedDataPath",
  input.derivedDataPath,
  "build",
];
