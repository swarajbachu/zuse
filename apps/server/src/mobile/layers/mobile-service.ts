import { Cause, Effect, Fiber, Layer, PubSub, Ref, Stream } from "effect";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MobileAvailability,
  MobileDevice,
  MobileFrame,
  MobileScreenshotError,
  MobileStartError,
  MobileStatus,
  MobileUnsupportedError,
  type MobileEvent,
  type MobilePhase,
  type MobileProjectDetection,
} from "@zuse/contracts";

import {
  buildXcodebuildArgs,
  detectProjectAtPath,
  parseSimctlDevices,
} from "../detection.ts";
import { MobileService } from "../services/mobile-service.ts";
import { PtyService } from "../../pty/services/pty-service.ts";
import type { PtyId } from "@zuse/contracts";

const INITIAL_STATUS = MobileStatus.make({ phase: "idle" });
const LOG_LIMIT = 500;

const execText = (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFileCb(
      command,
      [...args],
      { cwd, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${error.message}${stderr.length > 0 ? `\n${stderr}` : ""}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

const execBuffer = (
  command: string,
  args: ReadonlyArray<string>,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFileCb(
      command,
      [...args],
      { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${error.message}${Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr)}`,
            ),
          );
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });

const effectText = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
  Effect.tryPromise({
    try: () => execText(command, args, cwd),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

const effectBuffer = (command: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => execBuffer(command, args),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

const isSupported = () =>
  process.platform === "darwin"
    ? effectText("xcrun", ["--find", "simctl"]).pipe(
        Effect.map(() => MobileAvailability.make({ supported: true })),
        Effect.catchCause((cause) =>
          Effect.succeed(
            MobileAvailability.make({
              supported: false,
              reason: Cause.pretty(cause),
            }),
          ),
        ),
      )
    : Effect.succeed(
        MobileAvailability.make({
          supported: false,
          reason: "iOS simulator preview is only available on macOS.",
        }),
      );

const failUnsupported = (reason: string) =>
  Effect.fail(new MobileUnsupportedError({ reason }));

const logLines = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).filter((line) => line.trim().length > 0);

const findFirst = async (
  root: string,
  predicate: (entry: string) => boolean,
): Promise<string | null> => {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (predicate(full)) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return null;
};

const findXcodeContainer = async (
  cwd: string,
): Promise<{ kind: "workspace" | "project"; file: string } | null> => {
  const entries = await fs.readdir(cwd);
  const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
  if (workspace !== undefined) {
    return { kind: "workspace", file: path.join(cwd, workspace) };
  }
  const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
  if (project !== undefined) return { kind: "project", file: path.join(cwd, project) };
  return null;
};

const parseScheme = (json: string): string | null => {
  try {
    const parsed = JSON.parse(json) as {
      readonly project?: { readonly schemes?: ReadonlyArray<string> };
      readonly workspace?: { readonly schemes?: ReadonlyArray<string> };
    };
    return (
      parsed.project?.schemes?.[0] ?? parsed.workspace?.schemes?.[0] ?? null
    );
  } catch {
    return null;
  }
};

export const MobileServiceLive = Layer.effect(
  MobileService,
  Effect.gen(function* () {
    const pty = yield* PtyService;
    const statusRef = yield* Ref.make(MobileStatus.make(INITIAL_STATUS));
    const logRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const eventsPubSub = yield* PubSub.unbounded<typeof MobileEvent.Type>();
    const framesPubSub = yield* PubSub.sliding<MobileFrame>(1);
    const launchFiberRef = yield* Ref.make<Fiber.Fiber<unknown, unknown> | null>(
      null,
    );
    const frameFiberRef = yield* Ref.make<Fiber.Fiber<unknown, unknown> | null>(
      null,
    );
    const activePtyRef = yield* Ref.make<PtyId | null>(null);

    const publishStatus = (
      status: MobileStatus,
      source: "user" | "agent",
    ) =>
      Ref.set(statusRef, status).pipe(
        Effect.andThen(
          PubSub.publish(eventsPubSub, { _tag: "Status", status, source }),
        ),
        Effect.asVoid,
      );

    const appendLog = (text: string) =>
      Ref.update(logRef, (lines) => {
        const next = [...lines, ...logLines(text)];
        return next.slice(Math.max(0, next.length - LOG_LIMIT));
      }).pipe(
        Effect.andThen(PubSub.publish(eventsPubSub, { _tag: "LogChunk", text })),
        Effect.asVoid,
      );

    const listDevices = () =>
      isSupported().pipe(
        Effect.flatMap((availability) =>
          availability.supported
            ? effectText("xcrun", ["simctl", "list", "devices", "available", "-j"])
            : failUnsupported(availability.reason ?? "Unsupported platform."),
        ),
        Effect.map(parseSimctlDevices),
        Effect.catchCause((cause) =>
          failUnsupported(Cause.pretty(cause)),
        ),
      );

    const currentDevice = (udid: string) =>
      listDevices().pipe(
        Effect.map((devices) => devices.find((d) => d.udid === udid) ?? null),
      );

    const stopFrameLoop = Effect.gen(function* () {
      const fiber = yield* Ref.get(frameFiberRef);
      if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      yield* Ref.set(frameFiberRef, null);
    });

    const stopLaunch = Effect.gen(function* () {
      const fiber = yield* Ref.get(launchFiberRef);
      if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      yield* Ref.set(launchFiberRef, null);
      const activePty = yield* Ref.get(activePtyRef);
      if (activePty !== null) yield* pty.close(activePty).pipe(Effect.ignore);
      yield* Ref.set(activePtyRef, null);
    });

    const startFrameLoop = (udid: string) =>
      Effect.gen(function* () {
        yield* stopFrameLoop;
        const fiber = yield* Effect.forkDetach(
          Effect.forever(
            Effect.gen(function* () {
              const started = Date.now();
              const image = yield* effectBuffer("xcrun", [
                "simctl",
                "io",
                udid,
                "screenshot",
                "--type=jpeg",
                "-",
              ]).pipe(Effect.catchCause(() => Effect.succeed(null)));
              if (image !== null) {
                yield* PubSub.publish(
                  framesPubSub,
                  MobileFrame.make({ data: image.toString("base64") }),
                );
              }
              const elapsed = Date.now() - started;
              yield* Effect.sleep(`${Math.max(50, 125 - elapsed)} millis`);
            }),
          ),
        );
        yield* Ref.set(frameFiberRef, fiber);
      });

    const bootDevice = (device: MobileDevice) =>
      Effect.gen(function* () {
        if (device.state !== "Booted") {
          yield* appendLog(`Booting ${device.name} (${device.runtime})`);
          yield* effectText("xcrun", ["simctl", "boot", device.udid]).pipe(
            Effect.catchCause(() => Effect.succeed("")),
          );
        }
        yield* effectText("xcrun", [
          "simctl",
          "bootstatus",
          device.udid,
          "-b",
        ]);
      });

    const runSpawn = (
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
    ) =>
      Effect.callback<void, Error>((resume) => {
        const child = spawn(command, [...args], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => {
          Effect.runFork(appendLog(chunk.toString("utf8")));
        });
        child.stderr.on("data", (chunk) => {
          Effect.runFork(appendLog(chunk.toString("utf8")));
        });
        child.on("error", (err) => resume(Effect.fail(err)));
        child.on("close", (code) => {
          if (code === 0) resume(Effect.void);
          else resume(Effect.fail(new Error(`${command} exited with ${code}`)));
        });
        return Effect.sync(() => child.kill());
      });

    const startExpo = (
      cwd: string,
      udid: string,
      detection: MobileProjectDetection,
    ) =>
      Effect.gen(function* () {
        const runIos = detection.detail === "npx expo run:ios";
        const command = runIos
          ? { cmd: "npx", args: ["expo", "run:ios", "--device", udid] }
          : { cmd: "npx", args: ["expo", "start", "--ios"] };
        yield* appendLog(`Starting ${command.args.join(" ")}`);
        const opened = yield* pty.open(cwd, 120, 30, {
          ...command,
          env: { CI: "1", EXPO_NO_TELEMETRY: "1" },
        });
        yield* Ref.set(activePtyRef, opened.ptyId);
        yield* Effect.forkDetach(
          pty.subscribe(opened.ptyId).pipe(
            Stream.runForEach((event) =>
              event._tag === "data"
                ? appendLog(event.bytes)
                : appendLog(`Expo process exited with ${event.exitCode ?? event.signal ?? "unknown"}`),
            ),
            Effect.ignore,
          ),
        );
      });

    const startReactNative = (cwd: string, udid: string) =>
      Effect.gen(function* () {
        const command = {
          cmd: "npx",
          args: ["react-native", "run-ios", "--udid", udid],
        };
        yield* appendLog(`Starting ${command.args.join(" ")}`);
        const opened = yield* pty.open(cwd, 120, 30, {
          ...command,
          env: { CI: "1" },
        });
        yield* Ref.set(activePtyRef, opened.ptyId);
        yield* Effect.forkDetach(
          pty.subscribe(opened.ptyId).pipe(
            Stream.runForEach((event) =>
              event._tag === "data"
                ? appendLog(event.bytes)
                : appendLog(
                    `React Native process exited with ${event.exitCode ?? event.signal ?? "unknown"}`,
                  ),
            ),
            Effect.ignore,
          ),
        );
      });

    const startXcode = (cwd: string, udid: string) =>
      Effect.gen(function* () {
        const container = yield* Effect.tryPromise(() =>
          findXcodeContainer(cwd),
        ).pipe(
          Effect.mapError(
            (err) =>
              new Error(err instanceof Error ? err.message : String(err)),
          ),
        );
        if (container === null) {
          return yield* Effect.fail(new Error("No .xcworkspace or .xcodeproj found."));
        }

        const listArgs =
          container.kind === "workspace"
            ? ["-workspace", container.file, "-list", "-json"]
            : ["-project", container.file, "-list", "-json"];
        const listJson = yield* effectText("xcodebuild", listArgs, cwd);
        const scheme = parseScheme(listJson);
        if (scheme === null) {
          return yield* Effect.fail(new Error("No Xcode scheme found."));
        }
        const derivedDataPath = path.join(cwd, ".zuse", "derived");
        const buildArgs = buildXcodebuildArgs({
          kind: container.kind,
          path: container.file,
          scheme,
          udid,
          derivedDataPath,
        });
        yield* appendLog(`Building scheme ${scheme}`);
        yield* runSpawn("xcodebuild", buildArgs, cwd);
        const appPath = yield* Effect.tryPromise(() =>
          findFirst(path.join(derivedDataPath, "Build", "Products"), (entry) =>
            entry.endsWith(".app"),
          ),
        ).pipe(
          Effect.mapError(
            (err) =>
              new Error(err instanceof Error ? err.message : String(err)),
          ),
        );
        if (appPath === null) {
          return yield* Effect.fail(new Error("Build succeeded but no .app was found."));
        }
        const bundleId = (yield* effectText("plutil", [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          path.join(appPath, "Info.plist"),
        ])).trim();
        yield* appendLog(`Installing ${path.basename(appPath)}`);
        yield* effectText("xcrun", ["simctl", "install", udid, appPath]);
        yield* appendLog(`Launching ${bundleId}`);
        yield* effectText("xcrun", [
          "simctl",
          "launch",
          "--terminate-running-process",
          udid,
          bundleId,
        ]);
      });

    const startFlow = (
      cwd: string,
      udid: string,
      source: "user" | "agent",
    ) =>
      Effect.gen(function* () {
        yield* stopLaunch;
        yield* stopFrameLoop;
        yield* Ref.set(logRef, []);
        yield* publishStatus(MobileStatus.make({ phase: "detecting" }), source);
        const detection = yield* Effect.tryPromise(() => detectProjectAtPath(cwd));
        const device = yield* currentDevice(udid);
        if (device === null) {
          return yield* Effect.fail(new Error(`Simulator ${udid} was not found.`));
        }
        yield* publishStatus(
          MobileStatus.make({
            phase: "booting",
            projectType: detection,
            device,
          }),
          source,
        );
        yield* bootDevice(device);
        const booted = MobileDevice.make({ ...device, state: "Booted" });
        yield* startFrameLoop(udid);
        if (detection.type === "none") {
          return yield* Effect.fail(
            new Error("No Expo, React Native, or Xcode iOS project was detected."),
          );
        }
        yield* publishStatus(
          MobileStatus.make({
            phase: "building",
            projectType: detection,
            device: booted,
          }),
          source,
        );
        if (detection.type === "expo") {
          yield* startExpo(cwd, udid, detection);
        } else if (detection.type === "react-native") {
          yield* startReactNative(cwd, udid);
        } else {
          yield* startXcode(cwd, udid);
        }
        yield* publishStatus(
          MobileStatus.make({
            phase: "streaming",
            projectType: detection,
            device: booted,
          }),
          source,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(statusRef);
            const reason = Cause.pretty(cause);
            yield* appendLog(reason);
            yield* publishStatus(
              MobileStatus.make({
                ...current,
                phase: "error",
                error: reason,
              }),
              source,
            );
          }),
        ),
      );

    const availability: MobileService["Service"]["availability"] = isSupported;
    const detectProject: MobileService["Service"]["detectProject"] = (cwd) =>
      Effect.tryPromise(() => detectProjectAtPath(cwd)).pipe(
        Effect.catchCause(() =>
          Effect.succeed({ type: "none" } as MobileProjectDetection),
        ),
      );
    const start: MobileService["Service"]["start"] = (cwd, udid, source) =>
      Effect.gen(function* () {
        const availability = yield* isSupported();
        if (!availability.supported) {
          return yield* Effect.fail(
            new MobileStartError({
              phase: "idle",
              reason: availability.reason ?? "Unsupported platform.",
            }),
          );
        }
        const fiber = yield* Effect.forkDetach(startFlow(cwd, udid, source));
        yield* Ref.set(launchFiberRef, fiber);
      });
    const stop: MobileService["Service"]["stop"] = () =>
      Effect.gen(function* () {
        yield* stopLaunch;
        yield* stopFrameLoop;
        yield* publishStatus(MobileStatus.make(INITIAL_STATUS), "user");
      });
    const status: MobileService["Service"]["status"] = () => Ref.get(statusRef);
    const screenshot: MobileService["Service"]["screenshot"] = (source) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(statusRef);
        const udid = current.device?.udid;
        if (udid === undefined) {
          return yield* Effect.fail(
            new MobileScreenshotError({
              reason: "No simulator is active. Launch the Mobile panel first.",
            }),
          );
        }
        const image = yield* effectBuffer("xcrun", [
          "simctl",
          "io",
          udid,
          "screenshot",
          "--type=png",
          "-",
        ]).pipe(
          Effect.mapError(
            (err) => new MobileScreenshotError({ reason: err.message }),
          ),
        );
        yield* PubSub.publish(eventsPubSub, { _tag: "ShutterFlash" });
        yield* PubSub.publish(eventsPubSub, {
          _tag: "Status",
          status: current,
          source,
        });
        return { data: image.toString("base64") };
      });
    const events: MobileService["Service"]["events"] = () =>
      Stream.fromPubSub(eventsPubSub);
    const frames: MobileService["Service"]["frames"] = () =>
      Stream.fromPubSub(framesPubSub);
    const logTail: MobileService["Service"]["logTail"] = (lines) =>
      Ref.get(logRef).pipe(Effect.map((all) => all.slice(-lines).join("\n")));

    return {
      availability,
      listDevices,
      detectProject,
      start,
      stop,
      status,
      screenshot,
      events,
      frames,
      logTail,
    };
  }),
);
