import { useEffect, useRef } from "react";
import autoAnimate from "@formkit/auto-animate";
import type {
  AutoAnimateOptions,
  AutoAnimationPlugin,
} from "@formkit/auto-animate";

/**
 * Thin local wrapper around auto-animate's framework-agnostic core.
 *
 * We deliberately do NOT use `@formkit/auto-animate/react`: its bundled hook
 * pulls in its own React reference, which under Vite's dep pre-bundling can
 * resolve to a second React copy and throw "Invalid hook call". Driving the
 * core from our own `useEffect` guarantees only the app's React is ever used.
 *
 * Attach the returned ref to the parent element whose direct children should
 * animate on add / remove / reorder. Clean default ease, no spring.
 */
export function useAutoAnimate<T extends HTMLElement = HTMLElement>(
  config?: Partial<AutoAnimateOptions> | AutoAnimationPlugin,
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (ref.current === null) return;
    const controller = autoAnimate(ref.current, config);
    return () => controller.destroy?.();
  }, [config]);
  return ref;
}
