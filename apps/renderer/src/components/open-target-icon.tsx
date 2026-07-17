import type { OpenTarget } from "../lib/bridge.ts";

export function OpenTargetIcon({ target }: { target: OpenTarget }) {
  if (target.iconDataUrl !== null && target.iconDataUrl !== undefined) {
    return (
      <img
        alt=""
        src={target.iconDataUrl}
        className="size-5 shrink-0 rounded-[4px]"
      />
    );
  }
  return <span className="size-5 shrink-0" aria-hidden="true" />;
}
