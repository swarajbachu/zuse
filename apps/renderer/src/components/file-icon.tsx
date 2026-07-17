import { useEffect, useState } from "react";

type IconResolvers = typeof import("../lib/icons/material-icons.ts");
let resolvers: IconResolvers | null = null;
let resolverPromise: Promise<IconResolvers> | null = null;
const resolverListeners = new Set<() => void>();

const loadResolversAfterPaint = (): void => {
	if (resolverPromise !== null) return;
	requestAnimationFrame(() => {
		resolverPromise ??= import("../lib/icons/material-icons.ts").then(
			(loaded) => {
				resolvers = loaded;
				for (const listener of resolverListeners) listener();
				resolverListeners.clear();
				return loaded;
			},
		);
	});
};

type Props = {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly expanded?: boolean;
  readonly className?: string;
};

export function FileIcon({ name, kind, expanded = false, className }: Props) {
	const [, refresh] = useState(0);
	useEffect(() => {
		if (resolvers !== null) return;
		const listener = () => refresh((value) => value + 1);
		resolverListeners.add(listener);
		loadResolversAfterPaint();
		return () => {
			resolverListeners.delete(listener);
		};
	}, []);
  const url =
		resolvers === null
			? null
			: kind === "directory"
				? resolvers.getFolderIconUrl(name, expanded)
				: resolvers.getFileIconUrl(name);
  return (
    <span
      className={
        className ?? "inline-flex size-3.5 shrink-0 items-center justify-center"
      }
      aria-hidden="true"
    >
      {url ? (
        <img src={url} alt="" className="size-full" draggable={false} />
      ) : null}
    </span>
  );
}
