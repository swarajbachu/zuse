"use client";

import { useEffect, useState } from "react";

export function GradientGrid({ className }: { className?: string }) {
  const cellSize = 70;

  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const update = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const cols = Math.ceil(size.width / cellSize);
  const rows = Math.ceil(size.height / cellSize);

  const [filledCells, setFilledCells] = useState<Set<number>>(new Set());

  useEffect(() => {
    const set = new Set<number>();
    const total = rows * cols;

    while (set.size < Math.min(6, total)) {
      set.add(Math.floor(Math.random() * total));
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilledCells(set);
  }, [rows, cols]);

  return (
    <svg
      width="100%"
      height="100%"
      className={className}
    >
      <defs>
        <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {Array.from({ length: rows * cols }).map((_, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;

        const x = col * cellSize;
        const y = row * cellSize;

        const isFilled = filledCells.has(i);

        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={cellSize}
            height={cellSize}
            fill={isFilled ? "url(#goldGradient)" : "transparent"}
            stroke="rgba(255,255,255,0.08)"
          />
        );
      })}
    </svg>
  );
}
