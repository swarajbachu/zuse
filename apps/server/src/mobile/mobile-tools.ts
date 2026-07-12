import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { MobileDevice, MobileStatus } from "@zuse/contracts";

export interface MobileToolBridge {
  readonly status: () => Promise<MobileStatus>;
  readonly availability: () => Promise<{
    readonly supported: boolean;
    readonly reason?: string;
  }>;
  readonly listDevices: () => Promise<ReadonlyArray<MobileDevice>>;
  readonly detectProject: () => Promise<{
    readonly type: string;
    readonly detail?: string;
  }>;
  readonly launch: (device: string | undefined) => Promise<MobileStatus>;
  readonly screenshot: () => Promise<{ readonly data: string }>;
  readonly logTail: (lines: number) => Promise<string>;
}

const formatStatus = (
  status: MobileStatus,
  project: { readonly type: string; readonly detail?: string },
  devices: ReadonlyArray<MobileDevice>,
  logTail: string,
): string => {
  const device = status.device
    ? `${status.device.name} (${status.device.runtime}, ${status.device.state})`
    : "none";
  const deviceLines =
    devices.length === 0
      ? "No available simulators."
      : devices
          .slice(0, 12)
          .map((d) => `- ${d.name} (${d.runtime}) ${d.state} ${d.udid}`)
          .join("\n");
  return [
    `Mobile phase: ${status.phase}`,
    `Detected project: ${project.type}${project.detail ? ` (${project.detail})` : ""}`,
    `Active device: ${device}`,
    status.error ? `Error: ${status.error}` : null,
    "",
    "Devices:",
    deviceLines,
    "",
    "Recent log:",
    logTail.trim() || "(empty)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

export const buildMobileTools = (bridge: MobileToolBridge) => [
  tool(
    "mobile_status",
    "Report iOS simulator preview state: macOS support, detected mobile project type, available simulators, current phase, active device, and recent build/launch logs. Use this before launching or screenshotting mobile work.",
    {},
    async () => {
      const availability = await bridge.availability();
      if (!availability.supported) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Mobile preview is unavailable: ${availability.reason ?? "unsupported"}`,
            },
          ],
        };
      }
      const [status, project, devices, tail] = await Promise.all([
        bridge.status(),
        bridge.detectProject(),
        bridge.listDevices(),
        bridge.logTail(20),
      ]);
      return {
        content: [
          { type: "text" as const, text: formatStatus(status, project, devices, tail) },
        ],
      };
    },
  ),

  tool(
    "mobile_launch",
    "Launch the current project in an iOS Simulator and start the visible Mobile panel stream. Pass a simulator name or UDID for a specific device; omit it to use the active device or first available iPhone. Waits until the stream is running or an error occurs.",
    {
      device: z
        .string()
        .optional()
        .describe("Simulator name or UDID, for example 'iPhone 17 Pro'."),
    },
    async (args) => {
      try {
        const status = await bridge.launch(args.device);
        const tail = await bridge.logTail(40);
        if (status.phase === "error") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Mobile launch failed: ${status.error ?? "unknown error"}\n\n${tail}`,
              },
            ],
            isError: true as const,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Mobile stream is ${status.phase} on ${status.device?.name ?? "simulator"}.\n\n${tail}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true as const,
        };
      }
    },
  ),

  tool(
    "mobile_screenshot",
    "Capture the currently active iOS Simulator as a PNG image. Use it to verify mobile UI changes after mobile_launch reports the stream is running.",
    {},
    async () => {
      try {
        const result = await bridge.screenshot();
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: "image/png" as const,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true as const,
        };
      }
    },
  ),
];

