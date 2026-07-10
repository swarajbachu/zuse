import * as os from "node:os";
import * as path from "node:path";

import { FileSystem } from "effect";
import { Effect, Layer } from "effect";

import { Skill, type ProviderId } from "@zuse/contracts";

import { CodexAppServerClient } from "../../provider/codex-app-server-client.ts";
import { ensureBundledZuseSkillInstalled } from "../bundled-zuse-skill.ts";
import { SkillDiscoveryService } from "../services/skill-discovery.ts";

interface RawSkill {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly filePath: string;
}

/**
 * Parse YAML-like frontmatter at the top of a SKILL.md / prompt file.
 * Memoize only needs `name`, `description`, and `argument-hint`; we
 * deliberately keep the parser minimal — full YAML support belongs in
 * the provider, not here. Anything we don't recognise is ignored.
 */
const parseFrontmatter = (
  content: string,
): { name?: string; description?: string; argumentHint?: string } => {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const out: { name?: string; description?: string; argumentHint?: string } =
    {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else if (key === "argument-hint" || key === "argumenthint")
      out.argumentHint = val;
  }
  return out;
};

const fileStem = (p: string): string => {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/**
 * Read a single file safely; returns null on any error so the walker can
 * keep going. Skill discovery is best-effort — one malformed file should
 * not blank the whole popover.
 */
const readSafe = (
  fs: FileSystem.FileSystem,
  abs: string,
): Effect.Effect<string | null> =>
  fs.readFileString(abs).pipe(Effect.orElseSucceed(() => null));

const readDirSafe = (
  fs: FileSystem.FileSystem,
  abs: string,
): Effect.Effect<ReadonlyArray<string>> =>
  fs
    .readDirectory(abs)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

const isDirSafe = (
  fs: FileSystem.FileSystem,
  abs: string,
): Effect.Effect<boolean> =>
  fs.stat(abs).pipe(
    Effect.map((s) => s.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

/**
 * Project a parsed file into the wire `Skill` shape. The folder containing
 * the file becomes the canonical name when frontmatter omits it, mirroring
 * Claude Code's `~/.claude/skills/<name>/SKILL.md` convention.
 */
const toSkill = (
  raw: RawSkill,
  scope: "global" | "project",
  providerId: ProviderId,
): Skill =>
  Skill.make({
    name: raw.name,
    scope,
    description: raw.description,
    arguments: raw.argumentHint
      ? [{ name: raw.argumentHint, description: "", optional: true }]
      : [],
    filePath: raw.filePath,
    providerId,
  });

const dedupeProjectFirst = (skills: ReadonlyArray<Skill>): Skill[] => {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
};

export const SkillDiscoveryServiceLive = Layer.effect(
  SkillDiscoveryService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = os.homedir();

    /**
     * Walk a Claude skills root. Skills can be either:
     *   <root>/<name>/SKILL.md
     *   <root>/<name>.md
     * Both forms appear in the wild; we accept either.
     */
    const readClaudeSkillsRoot = (
      root: string,
    ): Effect.Effect<ReadonlyArray<RawSkill>> =>
      Effect.gen(function* () {
        const entries = yield* readDirSafe(fs, root);
        const out: RawSkill[] = [];
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const abs = path.join(root, entry);
          const isDir = yield* isDirSafe(fs, abs);
          let filePath: string | null = null;
          if (isDir) {
            const candidates = ["SKILL.md", "skill.md", `${entry}.md`];
            for (const c of candidates) {
              const candidate = path.join(abs, c);
              const exists = yield* fs
                .exists(candidate)
                .pipe(Effect.orElseSucceed(() => false));
              if (exists) {
                filePath = candidate;
                break;
              }
            }
          } else if (entry.endsWith(".md")) {
            filePath = abs;
          }
          if (filePath === null) continue;
          const content = yield* readSafe(fs, filePath);
          if (content === null) continue;
          const fm = parseFrontmatter(content);
          out.push({
            name: fm.name ?? (isDir ? entry : fileStem(entry)),
            description: fm.description ?? "",
            argumentHint: fm.argumentHint ?? "",
            filePath,
          });
        }
        return out;
      });

    /**
     * Plugins lay out as `~/.claude/plugins/<plugin>/skills/<skill>/SKILL.md`.
     * Surface them with `<plugin>:<skill>` so they don't collide with
     * top-level user skills, matching Claude Code's plugin namespacing.
     */
    const readClaudePluginsRoot = (
      root: string,
    ): Effect.Effect<ReadonlyArray<RawSkill>> =>
      Effect.gen(function* () {
        const entries = yield* readDirSafe(fs, root);
        const out: RawSkill[] = [];
        for (const plugin of entries) {
          if (plugin.startsWith(".")) continue;
          const skillsDir = path.join(root, plugin, "skills");
          const isDir = yield* isDirSafe(fs, skillsDir);
          if (!isDir) continue;
          const inner = yield* readClaudeSkillsRoot(skillsDir);
          for (const s of inner) {
            out.push({
              ...s,
              name: `${plugin}:${s.name}`,
            });
          }
        }
        return out;
      });

    /**
     * Codex prompts: `<root>/<name>.md`. First-line `# Title` is allowed
     * but the canonical name comes from the filename. Description is the
     * first non-blank, non-heading line.
     */
    const readCodexPromptsRoot = (
      root: string,
    ): Effect.Effect<ReadonlyArray<RawSkill>> =>
      Effect.gen(function* () {
        const entries = yield* readDirSafe(fs, root);
        const out: RawSkill[] = [];
        for (const entry of entries) {
          if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
          const abs = path.join(root, entry);
          const content = yield* readSafe(fs, abs);
          if (content === null) continue;
          const fm = parseFrontmatter(content);
          let description = fm.description ?? "";
          if (!description) {
            for (const line of content.split("\n").slice(0, 30)) {
              const t = line.trim();
              if (!t || t.startsWith("#") || t.startsWith("---")) continue;
              description = t;
              break;
            }
          }
          out.push({
            name: fm.name ?? fileStem(entry),
            description,
            argumentHint: fm.argumentHint ?? "",
            filePath: abs,
          });
        }
        return out;
      });

    const discoverClaude = (
      projectCwd: string,
    ): Effect.Effect<ReadonlyArray<Skill>> =>
      Effect.gen(function* () {
        ensureBundledZuseSkillInstalled("claude", home);
        const projectRoot = path.join(projectCwd, ".claude", "skills");
        const globalRoot = path.join(home, ".claude", "skills");
        const pluginsRoot = path.join(home, ".claude", "plugins");

        const projectRaw = yield* readClaudeSkillsRoot(projectRoot);
        const globalRaw = yield* readClaudeSkillsRoot(globalRoot);
        const pluginsRaw = yield* readClaudePluginsRoot(pluginsRoot);

        const merged: Skill[] = [
          ...projectRaw.map((r) => toSkill(r, "project", "claude")),
          ...globalRaw.map((r) => toSkill(r, "global", "claude")),
          ...pluginsRaw.map((r) => toSkill(r, "global", "claude")),
        ];
        return dedupeProjectFirst(merged);
      });

    const discoverCodex = (
      projectCwd: string,
    ): Effect.Effect<ReadonlyArray<Skill>> =>
      Effect.gen(function* () {
        ensureBundledZuseSkillInstalled("codex", home);
        const viaAppServer = yield* Effect.tryPromise({
          try: async (): Promise<ReadonlyArray<Skill>> => {
            const client = await CodexAppServerClient.start({
              codexPath: null,
              onNotification: () => undefined,
              onServerRequest: (_request, respond) => respond({}),
            });
            try {
              const response = await client.request<{
                data: ReadonlyArray<{
                  cwd: string;
                  skills: ReadonlyArray<{
                    name: string;
                    description: string;
                    shortDescription?: string;
                    path: string;
                    scope: "user" | "repo" | "system" | "admin";
                    enabled: boolean;
                  }>;
                }>;
              }>("skills/list", { cwds: [projectCwd], forceReload: false });
              return response.data.flatMap((entry) =>
                entry.skills
                  .filter((skill) => skill.enabled)
                  .map((skill) =>
                    Skill.make({
                      name: skill.name,
                      scope: skill.scope === "repo" ? "project" : "global",
                      description:
                        skill.shortDescription ?? skill.description ?? "",
                      arguments: [],
                      filePath: skill.path,
                      providerId: "codex",
                    }),
                  ),
              );
            } finally {
              client.close();
            }
          },
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        if (viaAppServer !== null) return dedupeProjectFirst(viaAppServer);

        const projectRoot = path.join(projectCwd, ".codex", "prompts");
        const globalRoot = path.join(home, ".codex", "prompts");
        const projectSkillsRoot = path.join(projectCwd, ".codex", "skills");
        const globalSkillsRoot = path.join(home, ".codex", "skills");
        const projectRaw = yield* readCodexPromptsRoot(projectRoot);
        const globalRaw = yield* readCodexPromptsRoot(globalRoot);
        const projectSkillsRaw = yield* readClaudeSkillsRoot(projectSkillsRoot);
        const globalSkillsRaw = yield* readClaudeSkillsRoot(globalSkillsRoot);
        const merged: Skill[] = [
          ...projectSkillsRaw.map((r) => toSkill(r, "project", "codex")),
          ...projectRaw.map((r) => toSkill(r, "project", "codex")),
          ...globalSkillsRaw.map((r) => toSkill(r, "global", "codex")),
          ...globalRaw.map((r) => toSkill(r, "global", "codex")),
        ];
        return dedupeProjectFirst(merged);
      });

    const discover: SkillDiscoveryService["Service"]["discover"] = (
      providerId,
      projectCwd,
    ) =>
      providerId === "claude"
        ? discoverClaude(projectCwd)
        : providerId === "codex"
          ? discoverCodex(projectCwd)
          : Effect.succeed([]);

    return { discover };
  }),
);
