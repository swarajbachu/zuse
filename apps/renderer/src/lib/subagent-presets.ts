import type { AgentDefinition } from "@zuse/wire";

/**
 * One named preset the user can toggle and edit. The `name` is the key the
 * SDK reports back as `subagent_type` on `Agent` tool_use blocks; the
 * `definition` mirrors the SDK's `AgentDefinition` shape.
 */
export interface SubagentPreset {
  readonly name: string;
  readonly displayName: string;
  /** A one-line summary shown in the settings list. */
  readonly summary: string;
  readonly definition: AgentDefinition;
}

/**
 * The three presets that ship with sub-agents v1. Numbers — model
 * choices, maxTurns, tool subsets — come from the spec at
 * `specs/sub-agents/features/preset-library.md`. Editing them in
 * settings copies a fresh definition into per-user overrides; this
 * array is the immutable seed.
 */
export const DEFAULT_SUBAGENT_PRESETS: ReadonlyArray<SubagentPreset> = [
  {
    name: "research",
    displayName: "Research",
    summary:
      "Read-only codebase exploration. Find files, understand patterns, list usages.",
    definition: {
      description:
        "Read-only codebase exploration. Use when you need to find files, " +
        "understand patterns, list usages of a symbol, or summarize " +
        "unfamiliar code. The agent has Read, Glob, and Grep — no edit, " +
        "no Bash, no network. Best for 'find every place that does X' " +
        "or 'how does Y work in this codebase' before making a change.",
      prompt:
        "You are a codebase research assistant. Your job is to find and " +
        "summarize information from the project. You have read-only " +
        "tools: Read, Glob, Grep. Be efficient — search precisely, read " +
        "only what's needed, return a concise summary that fully answers " +
        "the parent's question. Cite file paths and line numbers. Don't " +
        "speculate beyond the code you've actually read.",
      tools: ["Read", "Glob", "Grep"],
      model: "claude-haiku-4-5",
      maxTurns: 25,
    },
  },
  {
    name: "file-edits",
    displayName: "File edits",
    summary: "Apply well-defined refactors and renames across multiple files.",
    definition: {
      description:
        "Apply a well-defined file change. Use for routine refactors, " +
        "renames, prop additions, or any multi-file edit where the parent " +
        "agent has already decided what to change and just needs it " +
        "executed. Don't use this when the change requires architecture " +
        "decisions — keep that on the main model.",
      prompt:
        "You are a file editor. Apply the change described in the prompt " +
        "exactly. Read each file before editing it. Preserve existing " +
        "style — indentation, quote style, import order. If the change is " +
        "ambiguous, return without editing and ask the parent to clarify. " +
        "Don't refactor adjacent code, don't add comments, don't 'improve' " +
        "anything that isn't part of the requested change.",
      tools: ["Read", "Edit", "Write", "Glob"],
      model: "claude-sonnet-5",
      maxTurns: 40,
    },
  },
  {
    name: "test-runner",
    displayName: "Test runner",
    summary: "Run the project's test suite and report pass/fail summaries.",
    definition: {
      description:
        "Run a test suite and parse the output. Use after making changes " +
        "to verify nothing broke, or when the parent needs to see what's " +
        "currently failing. The agent runs the project's test command " +
        "(e.g. `bun test`, `vitest`, `pytest`) and returns a summary of " +
        "pass/fail counts plus the assertion text for any failures.",
      prompt:
        "You are a test runner. Detect the project's test command from " +
        "package.json scripts or by asking the parent. Run it. Parse the " +
        "output. Return: total passed, total failed, total skipped, and " +
        "for each failure, the test name + the assertion message + the " +
        "first frame of the stack that points to project code (skip " +
        "framework frames). Don't try to fix the failures — just report.",
      tools: ["Bash", "Read", "Grep"],
      model: "claude-haiku-4-5",
      maxTurns: 15,
      // Bash always prompts for this preset even if the parent session is
      // running in `full-access`. Belt-and-braces against a sub-agent
      // guessing the wrong test command and running something
      // destructive.
      permissionMode: "approval-required",
    },
  },
];

/** Look up the seed by name; used by the settings store on hydration. */
export const findSeed = (name: string): SubagentPreset | undefined =>
  DEFAULT_SUBAGENT_PRESETS.find((p) => p.name === name);
