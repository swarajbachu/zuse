"use client";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

interface SquareDotsProps {
  className?: string;
  color?: string;
  squareSize?: number;
  gap?: number;
}

export const SquareDots = ({
  className = "",
  color = "#ffffff",
  squareSize = 4,
  gap = 4,
}: SquareDotsProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        // Parse the color to RGB
        const tempDiv = document.createElement("div");
        tempDiv.style.color = color;
        document.body.appendChild(tempDiv);
        const computedColor = getComputedStyle(tempDiv).color;
        document.body.removeChild(tempDiv);

        const rgbMatch = computedColor.match(/\d+/g);
        const r = rgbMatch ? parseInt(rgbMatch[0]) : 255;
        const g = rgbMatch ? parseInt(rgbMatch[1]) : 255;
        const b = rgbMatch ? parseInt(rgbMatch[2]) : 255;

        // Use seeded random for consistent rendering
        const seed = 12345;
        let randomState = seed;
        const seededRandom = () => {
          randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
          return randomState / 0x7fffffff;
        };

        const step = squareSize + gap;
        const cols = Math.ceil(width / step);
        const rows = Math.ceil(height / step);

        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const opacity = seededRandom() * 0.5 + 0.05; // Random opacity between 0.05 and 0.55
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
            ctx.fillRect(col * step, row * step, squareSize, squareSize);
          }
        }
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [color, squareSize, gap]);

  return (
    <div
      ref={containerRef}
      className={cn("pointer-events-none select-none", className)}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
};
