import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import type {
  MobileAvailability,
  MobileDevice,
  MobileProjectDetection,
  MobileStatus,
} from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";
import { useUiStore } from "./ui.ts";

const SELECTED_DEVICE_KEY = "zuse.mobile.selectedDevice.v1";
const EMPTY_STATUS: MobileStatus = { phase: "idle" };

type MobileState = {
  readonly initialized: boolean;
  readonly availability: MobileAvailability | null;
  readonly devices: ReadonlyArray<MobileDevice>;
  readonly selectedUdid: string | null;
  readonly status: MobileStatus;
  readonly log: ReadonlyArray<string>;
  readonly frameUrl: string | null;
  readonly shutterNonce: number;
  readonly init: () => void;
  readonly refreshDevices: () => Promise<void>;
  readonly setSelectedUdid: (udid: string | null) => void;
  readonly subscribeEvents: () => void;
  readonly subscribeFrames: () => void;
  readonly unsubscribeFrames: () => void;
  readonly start: (cwd: string, udid: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly detectProject: (cwd: string) => Promise<MobileProjectDetection>;
};

let eventFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
let frameFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;

const readSelected = (): string | null => {
  try {
    return window.localStorage.getItem(SELECTED_DEVICE_KEY);
  } catch {
    return null;
  }
};

const writeSelected = (udid: string | null): void => {
  try {
    if (udid === null) window.localStorage.removeItem(SELECTED_DEVICE_KEY);
    else window.localStorage.setItem(SELECTED_DEVICE_KEY, udid);
  } catch {
    // localStorage is cosmetic only.
  }
};

const pushLog = (
  current: ReadonlyArray<string>,
  text: string,
): ReadonlyArray<string> => {
  const next = [
    ...current,
    ...text.split(/\r?\n/).filter((line) => line.trim().length > 0),
  ];
  return next.slice(Math.max(0, next.length - 500));
};

export const useMobileStore = create<MobileState>((set, get) => ({
  initialized: false,
  availability: null,
  devices: [],
  selectedUdid: typeof window === "undefined" ? null : readSelected(),
  status: EMPTY_STATUS,
  log: [],
  frameUrl: null,
  shutterNonce: 0,
  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    void (async () => {
      const client = await getRpcClient();
      const availability = await Effect.runPromise(
        client.mobile.availability({}),
      );
      set({ availability });
      if (availability.supported) {
        await get().refreshDevices();
        get().subscribeEvents();
      }
    })();
  },
  refreshDevices: async () => {
    const client = await getRpcClient();
    const devices = await Effect.runPromise(client.mobile.listDevices({}));
    const selected = get().selectedUdid;
    const nextSelected =
      selected !== null && devices.some((d) => d.udid === selected)
        ? selected
        : (devices.find((d) => d.name.includes("iPhone")) ?? devices[0])?.udid ??
          null;
    set({ devices, selectedUdid: nextSelected });
    writeSelected(nextSelected);
  },
  setSelectedUdid: (udid) => {
    set({ selectedUdid: udid });
    writeSelected(udid);
  },
  subscribeEvents: () => {
    if (eventFiber !== null) return;
    void (async () => {
      const client = await getRpcClient();
      eventFiber = Effect.runFork(
        Stream.runForEach(client.mobile.events({}), (event) =>
          Effect.sync(() => {
            if (event._tag === "Status") {
              set({ status: event.status });
              if (event.status.device !== undefined) {
                get().setSelectedUdid(event.status.device.udid);
              }
              if (event.source === "agent") {
                useUiStore.getState().revealPanel("mobile");
              }
            } else if (event._tag === "LogChunk") {
              set((s) => ({ log: pushLog(s.log, event.text) }));
            } else {
              set((s) => ({ shutterNonce: s.shutterNonce + 1 }));
              useUiStore.getState().revealPanel("mobile");
            }
          }),
        ),
      );
    })();
  },
  subscribeFrames: () => {
    if (frameFiber !== null) return;
    void (async () => {
      const client = await getRpcClient();
      frameFiber = Effect.runFork(
        Stream.runForEach(client.mobile.frames({}), (frame) =>
          Effect.sync(() => {
            set({ frameUrl: `data:image/jpeg;base64,${frame.data}` });
          }),
        ),
      );
    })();
  },
  unsubscribeFrames: () => {
    if (frameFiber === null) return;
    const fiber = frameFiber;
    frameFiber = null;
    void Effect.runPromise(Fiber.interrupt(fiber));
  },
  start: async (cwd, udid) => {
    const client = await getRpcClient();
    set({ log: [], frameUrl: null });
    await Effect.runPromise(client.mobile.start({ cwd, udid, source: "user" }));
  },
  stop: async () => {
    const client = await getRpcClient();
    await Effect.runPromise(client.mobile.stop({}));
  },
  detectProject: async (cwd) => {
    const client = await getRpcClient();
    return await Effect.runPromise(client.mobile.detectProject({ cwd }));
  },
}));

