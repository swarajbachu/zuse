"use client";

import { Container } from "@/components/container";
import { Button } from "@/components/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { motion, type Variants } from "motion/react";
import { GlobeLight } from "@/components/hero/globe-light";
import { LightAbove } from "@/components/hero/light-above";
import { Stars } from "@/components/hero/stars";
import { GradientGrid } from "@/components/hero/gradient-grid";
import { GITHUB_URL, SITE_NAME } from "@/lib/site";

const layersContainerVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.25, delayChildren: 0.2 },
  },
};

const layerVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.8, ease: "easeInOut" } },
};

// Grid stays dimmed, so it fades to 0.2 instead of full opacity.
const gridLayerVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 0.2, transition: { duration: 0.8, ease: "easeInOut" } },
};

const lightAboveVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 0.4, transition: { duration: 0.8, ease: "easeInOut" } },
};

export const Hero = () => {
  return (
    <div className="h-[60vh] w-full p-2 md:h-screen">
      <div className="text-natural-white relative m-0 h-full w-full overflow-hidden rounded-3xl bg-black">
        <motion.div
          className="absolute inset-0 h-full w-full"
          variants={layersContainerVariants}
          initial="hidden"
          animate="show"
        >
          <motion.div
            variants={gridLayerVariants}
            className="h-1/2 w-full mask-[linear-gradient(to_bottom,transparent_0%,black_50%,transparent_100%)]"
          >
            <GradientGrid />
          </motion.div>
          <motion.div
            variants={layerVariants}
            className="absolute -bottom-75 left-1/2 flex h-full w-full -translate-x-1/2 justify-center"
          >
            <div className="w-fit">
              <GlobeLight />
            </div>
          </motion.div>
          <motion.div
            variants={layerVariants}
            className="absolute -bottom-10 left-1/2 z-0 flex h-full w-full -translate-x-1/2 justify-center"
          >
            <div className="w-fit">
              <Stars />
            </div>
          </motion.div>
          <motion.div
            variants={lightAboveVariants}
            className="absolute bottom-0 left-1/2 z-5 flex h-full w-full -translate-x-1/2 justify-center"
          >
            <div className="w-fit">
              <LightAbove />
            </div>
          </motion.div>
        </motion.div>
        <Container className="relative z-10 flex h-full flex-col justify-between">
          <div className="pt-32 md:pt-42 lg:pt-75">
            <Link
              href={GITHUB_URL}
              target="_blank"
              className="flex w-fit rounded-full bg-neutral-900 p-1 shadow-lg shadow-black"
            >
              <div className="flex items-center gap-1 sm:gap-2">
                <div className="bg-primary text-primary-foreground rounded-full px-2 py-1 text-[10px] font-medium sm:text-xs">
                  Beta
                </div>
                <div className="text-natural-white rounded-full pr-2 text-[10px] sm:text-xs">
                  Public beta — built for token maxing
                </div>
              </div>
            </Link>
            <div className="mt-6 flex flex-col items-start gap-6 md:mt-10 lg:flex-row lg:gap-10">
              <h1 className="text-natural-white -tracking-xl text-3xl font-semibold text-balance sm:text-4xl md:text-5xl lg:text-7xl">
                Token max every coding agent.
              </h1>
              <div className="lg:max-w-md">
                <h2 className="text-sm font-medium text-balance text-neutral-300 sm:text-base lg:text-lg">
                  For developers who want to code all day, keep every agent
                  working, and squeeze real progress out of every subscription
                  they pay for. More attempts, cleaner branches, faster shipping.
                </h2>
                <Button containerClassName="mt-6 md:mt-8" />
                <p className="text-natural-white/50 mt-3 text-xs">
                  macOS app · BYOK · no token markup
                </p>
              </div>
            </div>
          </div>
          <div className="relative h-18 sm:h-48 md:h-72">
            <p
              className={cn(
                "from-natural-white/10 -tracking-xl to-heading/0 bg-linear-to-r bg-clip-text text-transparent",
                "absolute -top-10 left-1/2 -translate-x-1/2 text-center text-[100px] font-semibold sm:text-[6rem] md:-top-6 md:mt-10 md:text-[160px] lg:-top-18 lg:text-[300px]",
              )}
            >
              {SITE_NAME}
            </p>
          </div>
        </Container>
      </div>
    </div>
  );
};
