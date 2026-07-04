export const isPatchDiffRenderable = (patch: string): boolean => {
  const trimmed = patch.trimStart();
  return (
    trimmed.startsWith("diff --git") ||
    trimmed.startsWith("--- ") ||
    trimmed.startsWith("@@")
  );
};
