import { describe, expect, it } from "vitest";

import {
  buildXcodebuildArgs,
  detectFromFiles,
  parseSimctlDevices,
} from "../../src/mobile/detection.ts";

describe("mobile simulator helpers", () => {
  it("parses available simctl devices and prefers booted iPhones", () => {
    const devices = parseSimctlDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            {
              udid: "ipad",
              isAvailable: true,
              state: "Shutdown",
              name: "iPad Pro 13-inch (M4)",
            },
            {
              udid: "phone",
              isAvailable: true,
              state: "Booted",
              name: "iPhone 17 Pro",
            },
            {
              udid: "gone",
              isAvailable: false,
              state: "Shutdown",
              name: "iPhone Old",
            },
          ],
        },
      }),
    );

    expect(devices.map((d) => d.udid)).toEqual(["phone", "ipad"]);
    expect(devices[0]?.runtime).toBe("iOS 26.0");
    expect(devices[0]?.state).toBe("Booted");
  });

  it("parses empty simctl output", () => {
    expect(parseSimctlDevices('{"devices":{}}')).toEqual([]);
  });

  it("detects Expo projects", () => {
    expect(
      detectFromFiles(["package.json", "app.json"], {
        dependencies: { expo: "^55.0.0" },
      }).type,
    ).toBe("expo");
    expect(
      detectFromFiles(["package.json", "app.json", "ios"], {
        dependencies: { expo: "^55.0.0" },
      }).detail,
    ).toBe("npx expo run:ios");
  });

  it("detects bare React Native projects", () => {
    const detection = detectFromFiles(["package.json", "ios"], {
      dependencies: { "react-native": "1.0.0" },
    });
    expect(detection.type).toBe("react-native");
  });

  it("detects Xcode and non-mobile projects", () => {
    expect(detectFromFiles(["App.xcworkspace"], null).type).toBe("xcode");
    expect(detectFromFiles(["README.md"], null).type).toBe("none");
  });

  it("builds xcodebuild simulator args", () => {
    expect(
      buildXcodebuildArgs({
        kind: "workspace",
        path: "/repo/App.xcworkspace",
        scheme: "App",
        udid: "abc",
        derivedDataPath: "/repo/.zuse/derived",
      }),
    ).toEqual([
      "-workspace",
      "/repo/App.xcworkspace",
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      "platform=iOS Simulator,id=abc",
      "-derivedDataPath",
      "/repo/.zuse/derived",
      "build",
    ]);
  });
});
