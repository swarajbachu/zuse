import { HugeiconsIcon } from "@hugeicons/react";
import {
  ActivitySparkIcon,
  AiDnaIcon,
  ArtificialIntelligence08Icon,
  Atom02Icon,
  Flower2Icon,
  GeometricShapes02Icon,
} from "@hugeicons-pro/core-solid-rounded";

const ICONS = [
  Atom02Icon,
  Flower2Icon,
  GeometricShapes02Icon,
  ActivitySparkIcon,
  AiDnaIcon,
  ArtificialIntelligence08Icon,
] as const;

const TONES = [
  "text-cyan-500 dark:text-cyan-300",
  "text-yellow-500 dark:text-yellow-300",
  "text-lime-600 dark:text-lime-300",
  "text-blue-500 dark:text-blue-300",
  "text-fuchsia-500 dark:text-fuchsia-300",
  "text-orange-500 dark:text-orange-300",
] as const;

const identityIndex = (name: string): number => {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash;
};

export function SubagentAvatar({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "sm" | "md";
}) {
  const index = identityIndex(name);
  const icon = ICONS[index % ICONS.length] ?? Atom02Icon;
  const tone = TONES[index % TONES.length] ?? TONES[0];
  return (
    <span
      className={`grid shrink-0 place-items-center ${size === "sm" ? "size-5" : "size-7"} ${tone}`}
      aria-hidden="true"
    >
      <HugeiconsIcon icon={icon} className={size === "sm" ? "size-4" : "size-6"} />
    </span>
  );
}
