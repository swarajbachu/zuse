import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { AppearanceMode } from "@zuse/contracts";

import { useSettingsStore } from "../store/settings.ts";

export type ResolvedAppearance = "light" | "dark";

const subscribeSystemAppearance = (onStoreChange: () => void): (() => void) => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
};

const getSystemAppearance = (): ResolvedAppearance => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

export const resolveAppearance = (
  mode: AppearanceMode,
  systemAppearance: ResolvedAppearance,
): ResolvedAppearance => (mode === "system" ? systemAppearance : mode);

export function useResolvedAppearance(): ResolvedAppearance {
  const appearanceMode = useSettingsStore((s) => s.appearanceMode);
  const systemAppearance = useSyncExternalStore(
    subscribeSystemAppearance,
    getSystemAppearance,
    (): ResolvedAppearance => "dark",
  );
  return useMemo(
    () => resolveAppearance(appearanceMode, systemAppearance),
    [appearanceMode, systemAppearance],
  );
}

export function AppearanceController() {
  const appearanceMode = useSettingsStore((s) => s.appearanceMode);
  const resolvedAppearance = useResolvedAppearance();

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedAppearance === "dark");
    root.style.colorScheme = resolvedAppearance;
    window.zuse?.window?.setAppearanceMode?.(appearanceMode);
    window.dispatchEvent(
      new CustomEvent("zuse:appearance-change", {
        detail: { mode: appearanceMode, resolved: resolvedAppearance },
      }),
    );
  }, [appearanceMode, resolvedAppearance]);

  return null;
}
