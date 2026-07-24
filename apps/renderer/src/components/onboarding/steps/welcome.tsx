export function WelcomeStep() {
  return (
    <div className="flex h-full flex-col gap-10">
      <div className="flex flex-col gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
          Welcome to Zuse (Beta)
        </span>
        <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-foreground">
          Every agent,
          <br />
          one workspace.
        </h1>
        <p className="max-w-md pt-1 text-[15px] leading-relaxed text-muted-foreground">
          Run Claude, Codex, Grok and more on your repos, side by side.
        </p>
      </div>

      <ul className="flex flex-col gap-0.5 text-sm">
        <Row title="Credentials stay local">
          Reuses supported CLI auth or API keys stored in your OS keychain.
        </Row>
        <Row title="A worktree per chat">
          Each agent runs on its own branch.
        </Row>
        <Row title="Built for token maxers">
          Run agents in parallel, get more from every plan.
        </Row>
      </ul>
    </div>
  );
}

function Row({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-baseline gap-3 py-2">
      <span className="flex size-1 shrink-0 translate-y-[-3px] rounded-full bg-foreground/40" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-xs leading-snug text-muted-foreground">
          {children}
        </span>
      </span>
    </li>
  );
}
