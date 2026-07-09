import type { GitMergeMethod } from "@zuse/wire";

import { useSettingsStore } from "./settings.ts";

type MergePrefsState = {
  readonly method: GitMergeMethod;
  readonly deleteBranch: boolean;
  readonly setMethod: (method: GitMergeMethod) => void;
  readonly setDeleteBranch: (deleteBranch: boolean) => void;
};

const setMethod = (method: GitMergeMethod): void => {
  const settings = useSettingsStore.getState();
  settings.setMergePrefs({ ...settings.mergePrefs, method });
};

const setDeleteBranch = (deleteBranch: boolean): void => {
  const settings = useSettingsStore.getState();
  settings.setMergePrefs({ ...settings.mergePrefs, deleteBranch });
};

/**
 * Compatibility hook for the top-bar merge menu. Preferences now persist in
 * `settings.json` through `useSettingsStore`.
 */
export function useMergePrefs<T>(selector: (state: MergePrefsState) => T): T {
  return useSettingsStore((settings) =>
    selector({
      method: settings.mergePrefs.method,
      deleteBranch: settings.mergePrefs.deleteBranch,
      setMethod,
      setDeleteBranch,
    }),
  );
}
