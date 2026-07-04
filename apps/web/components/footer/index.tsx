import Link from "next/link";

import { cn } from "@/lib/utils";
import { Container } from "@/components/container";
import {
  ArrowRightLongerIcon,
  CopyRightIcon,
  XformerlyTwitter,
} from "@/components/icons/general";
import { IconBrandGithub } from "@tabler/icons-react";
import { Button } from "@/components/button";
import { Logo } from "@/components/logo";
import { DOWNLOAD_URL, GITHUB_URL, RELEASES_URL } from "@/lib/site";
import Image from "next/image";

const data = {
  Product: [
    { label: "Features", href: "/#features" },
    { label: "Compare", href: "/#compare" },
    { label: "FAQ", href: "/#faq" },
    { label: "Download", href: DOWNLOAD_URL },
    { label: "Change Log", href: "/changelog" },
  ],
  Agents: [
    { label: "Claude Code", href: "/#features" },
    { label: "Codex", href: "/#features" },
    { label: "Cursor", href: "/#features" },
    { label: "Gemini", href: "/#features" },
    { label: "Grok & OpenCode", href: "/#features" },
  ],
  Resources: [
    { label: "Blog", href: "/blog" },
    { label: "Change Log", href: "/changelog" },
    { label: "GitHub", href: GITHUB_URL },
    { label: "Releases", href: RELEASES_URL },
    { label: "Issues", href: `${GITHUB_URL}/issues` },
    { label: "Discussions", href: `${GITHUB_URL}/discussions` },
  ],
  Legal: [
    { label: "Privacy Policy", href: "#" },
    { label: "Terms of Service", href: "#" },
    { label: "License", href: "#" },
    { label: "Security", href: "#" },
  ],
};

export const Footer = () => {
  return (
    <footer className="bg-natural-black relative overflow-hidden">
      <div className="absolute inset-0 -left-128.75">
        <div className="absolute top-0 left-[387.07px] h-293.75 w-[720.16px] rounded-full bg-[#15171A] blur-[287.15px]" />
        <div className="absolute top-[284.85px] left-0 h-[502.50px] w-[488.15px] rounded-full bg-white blur-[215.36px]" />
      </div>
      <Container className="flex flex-col gap-30 pt-20 pb-10">
        <div className="bg-natural-white/5 shadow-card-xl relative min-h-112 overflow-hidden rounded-4xl">
          <div
            className={cn(
              "-tracking-xl absolute top-51 -left-3.25 justify-start text-[132px] leading-75 font-medium opacity-25 md:text-[240px] lg:text-[300px]",
              "bg-[linear-gradient(90deg,#FFFFFF_0%,rgba(52,52,52,0)_100%)] bg-clip-text text-transparent",
            )}
          >
            Zuse Alpha
          </div>
          <div className="relative z-10 grid min-h-112 grid-cols-1 gap-8 px-6 py-10 md:px-15 md:py-16 lg:grid-cols-[1fr_520px] lg:items-start">
            <div className="flex flex-col gap-8">
              <div className="text-natural-white -tracking-lg w-full max-w-135 justify-center text-[32px] font-medium md:text-5xl md:leading-14 lg:text-[56px] lg:leading-16">
                Token max every coding agent from one Mac app
              </div>
              <Button text="Download for Mac" />
            </div>
            <div className="relative hidden min-h-76 overflow-hidden rounded-3xl bg-[#101113] p-5 shadow-card-xl lg:block">
              <div className="absolute inset-0 bg-[linear-gradient(to_right,#24272A_1px,transparent_1px),linear-gradient(to_bottom,#24272A_1px,transparent_1px)] bg-size-[44px_44px] opacity-40" />
              <div className="relative z-10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Image
                    src="/app-icon.png"
                    alt=""
                    width={48}
                    height={48}
                    className="size-12 rounded-xl"
                  />
                  <div>
                    <div className="text-natural-white text-sm font-semibold">
                      Zuse Alpha workspace
                    </div>
                    <div className="text-muted-foreground text-xs">
                      subscriptions ready
                    </div>
                  </div>
                </div>
                <Link
                  href={DOWNLOAD_URL}
                  aria-label="Download Zuse Alpha for Mac"
                  className="bg-primary text-primary-foreground shadow-card-md inline-flex size-12 items-center justify-center rounded-xl"
                >
                  <ArrowRightLongerIcon className="scale-125" />
                </Link>
              </div>
              <div className="relative z-10 mt-8 grid grid-cols-3 gap-3">
                {["parallel runs", "worktrees", "diff review"].map((agent) => (
                  <div
                    key={agent}
                    className="rounded-xl bg-primary px-3 py-2 text-center text-xs font-semibold text-primary-foreground"
                  >
                    {agent}
                  </div>
                ))}
              </div>
              <div className="relative z-10 mt-6 flex flex-col gap-3">
                {[
                  ["agent runs", "Keep useful work moving"],
                  ["worktree", "Branch isolated for review"],
                  ["diff pane", "Only ship what you approve"],
                ].map(([title, detail]) => (
                  <div key={title} className="rounded-2xl bg-white/8 px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-natural-white text-sm font-medium">
                        {title}
                      </span>
                      <span className="bg-primary size-2 rounded-full" />
                    </div>
                    <div className="text-muted-foreground mt-1 text-xs">
                      {detail}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="relative z-10 flex flex-col items-center justify-center gap-18">
          <div className="grid w-full grid-cols-1 gap-15 lg:grid-cols-2 lg:gap-0">
            <div className="flex flex-col gap-4">
              <Logo className="size-8" />
              <span className="text-muted-foreground text-sm leading-5">
                Token max every coding agent from one local Mac workspace.
              </span>
              <div>
                <Button text="Download for Mac" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-10 md:grid-cols-4 md:gap-0">
              {Object.entries(data).map(([key, value]) => (
                <div key={key} className="flex flex-col gap-4">
                  <h3 className="text-muted-foreground -tracking-sm text-xs leading-5 font-medium">
                    {key}
                  </h3>
                  <ul className="flex flex-col gap-4">
                    {value.map((item, index) => (
                      <li key={index}>
                        <Link
                          href={item.href}
                          className="text-natural-white -tracking-sm text-sm leading-5 font-medium hover:underline"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
          <div className="flex w-full flex-col justify-between gap-6 md:flex-row md:items-center md:gap-0">
            <div>
              <span className="flex items-center gap-1">
                <CopyRightIcon />
                <span className="text-muted-foreground text-xs leading-5 font-medium">
                  2026 Zuse Alpha — All Rights Reserved
                </span>
              </span>
            </div>
            <div className="flex items-center gap-5">
              <Link href={GITHUB_URL} target="_blank" aria-label="GitHub">
                <IconBrandGithub className="text-muted-foreground hover:text-natural-white size-4 transition-colors" />
              </Link>
              <Link href={"https://x.com/swarajbachu"} target="_blank" aria-label="X">
                <XformerlyTwitter className="text-muted-foreground hover:text-natural-white size-4 transition-colors" />
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </footer>
  );
};
