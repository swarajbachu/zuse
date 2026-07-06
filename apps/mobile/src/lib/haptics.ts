// Thin, crash-safe wrapper around expo-haptics. `require` (not static import) so
// the app still runs in a dev client built *before* expo-haptics was linked —
// the module simply resolves to null and every call becomes a no-op.
type HapticsModule = typeof import("expo-haptics");

let Haptics: HapticsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Haptics = require("expo-haptics") as HapticsModule;
} catch {
  Haptics = null;
}

/** Light tap — row selection, navigation. */
export const lightTap = () => {
  void Haptics?.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

/** Success notification — a connection landed, an action completed. */
export const successTap = () => {
  void Haptics?.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {}
  );
};

/** Error notification — a connection or action failed. */
export const errorTap = () => {
  void Haptics?.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
    () => {}
  );
};
