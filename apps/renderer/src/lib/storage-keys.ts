export const readStorageWithLegacy = (
  storage: Storage,
  key: string,
  legacyKeys: ReadonlyArray<string>,
): string | null => {
  const current = storage.getItem(key);
  if (current !== null) return current;

  for (const legacyKey of legacyKeys) {
    const legacy = storage.getItem(legacyKey);
    if (legacy === null) continue;
    try {
      storage.setItem(key, legacy);
      storage.removeItem(legacyKey);
    } catch {
      // Storage migration is best-effort; the caller can still use the value.
    }
    return legacy;
  }

  return null;
};

export const removeStorageKeys = (
  storage: Storage,
  key: string,
  legacyKeys: ReadonlyArray<string>,
): void => {
  storage.removeItem(key);
  for (const legacyKey of legacyKeys) storage.removeItem(legacyKey);
};
