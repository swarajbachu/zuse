"use client";
import React, { useEffect, useState } from "react";
import { Container } from "@/components/container";
import { motion, AnimatePresence } from "motion/react";
import { AGENTS } from "@/lib/site";

// The coding agents Zuse Alpha wraps. We have no logo assets, so render the
// agent names as clean text badges in the marquee row.
const allAgents = AGENTS.map((name, i) => ({ id: i + 1, name }));

const DISPLAY_COUNT = allAgents.length;

export const LogoCloud = () => {
  const [displayedAgents, setDisplayedAgents] = useState(
    allAgents.slice(0, DISPLAY_COUNT),
  );

  // Cycle the entrance animation so the row keeps a subtle life to it, the
  // same cadence as the rotating logo cloud.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCycle((c) => c + 1);
      setDisplayedAgents((current) => {
        const next = [...current];
        const last = next.pop();
        if (last) next.unshift(last);
        return next;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <Container className="max-w-7xl py-20">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
        <h2 className="font-dm-mono -tracking-xs text-primary text-sm leading-4 font-semibold uppercase">
          Use the subscriptions you already pay for
        </h2>
        <p className="text-muted-foreground text-base leading-6 font-medium">
          Zuse Alpha does not sell model credits. Bring your own keys, run the
          agents you already trust, and push more useful work through them.
        </p>
      </div>

      <div className="mx-auto mt-10 flex max-w-5xl flex-wrap items-center justify-center gap-3 md:gap-4">
        {displayedAgents.map((agent, index) => (
          <motion.div
            key={agent.id}
            style={{ perspective: 800 }}
            className="relative transition-all duration-300"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={`${agent.id}-${cycle}`}
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -20, opacity: 0 }}
                transition={{
                  duration: 0.3,
                  delay: index * 0.04,
                  ease: "easeInOut",
                }}
              >
                <span className="bg-primary flex items-center rounded-full px-4 py-1.5 text-sm font-semibold whitespace-nowrap text-primary-foreground">
                  {agent.name}
                </span>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        ))}
      </div>
    </Container>
  );
};
