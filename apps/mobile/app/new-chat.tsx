import type {
  Folder,
  GitBranchInfo,
  GitPrSummary,
  Worktree,
} from "@zuse/wire";
import { Effect } from "effect";
import { router, Stack } from "expo-router";
import {
  Check,
  CloudOff,
  GitBranch,
  GitPullRequest,
  Layers3,
  Send,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  createWorktree,
  listBranches,
  listPullRequests,
  listWorktrees,
} from "~/rpc/actions";
import { optionsForConnection } from "~/lib/connection-params";
import {
  buildNewChatCreatePayload,
  MAIN_SOURCE,
  type NewChatSource,
} from "~/lib/new-chat";
import {
  defaultModelForProvider,
} from "~/lib/model-options";
import { useConnectionsStore } from "~/store/connections";
import { useSessionsStore } from "~/store/sessions";
import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import {
  ModelModeTrigger,
  type ModelModeValue,
} from "~/components/model-mode-sheet";

const ACCENT = "hsl(72 98% 54%)";

export default function NewChatScreen() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [selectedConnectionKey, setSelectedConnectionKey] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<Folder["id"] | null>(null);
  const [source, setSource] = useState<NewChatSource>(MAIN_SOURCE);
  const [modelMode, setModelMode] = useState<ModelModeValue>({
    providerId: "codex",
    model: defaultModelForProvider("codex"),
    runtimeMode: "approval-required",
    permissionMode: "default",
  });
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([]);
  const [branches, setBranches] = useState<readonly GitBranchInfo[]>([]);
  const [prs, setPrs] = useState<readonly GitPrSummary[]>([]);

  const {
    connections,
    hydrated,
    hydrate: hydrateConnections,
  } = useConnectionsStore();
  const {
    bundlesByConnection,
    loadingByConnection,
    hydrate: hydrateSessions,
    createChat,
  } = useSessionsStore();

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    for (const connection of connections) {
      const options = optionsForConnection(connection.key, connections);
      if (options !== null) void hydrateSessions(connection.key, options);
    }
  }, [connections, hydrateSessions]);

  const effectiveConnectionKey =
    selectedConnectionKey ?? connections[0]?.key ?? null;

  const projectChoices = useMemo(() => {
    if (effectiveConnectionKey === null) return [];
    return (bundlesByConnection[effectiveConnectionKey] ?? []).map((bundle) => ({
      project: bundle.project,
      connectionKey: effectiveConnectionKey,
    }));
  }, [bundlesByConnection, effectiveConnectionKey]);

  const effectiveProjectId =
    selectedProjectId !== null &&
    projectChoices.some((item) => item.project.id === selectedProjectId)
      ? selectedProjectId
      : (projectChoices[0]?.project.id ?? null);

  const selectedOptions = useMemo(
    () =>
      effectiveConnectionKey === null
        ? null
        : optionsForConnection(effectiveConnectionKey, connections),
    [connections, effectiveConnectionKey],
  );

  useEffect(() => {
    if (selectedOptions === null || effectiveProjectId === null) return;
    let cancelled = false;
    void Promise.all([
      Effect.runPromise(
        listWorktrees({ connection: selectedOptions, projectId: effectiveProjectId }),
      ).catch(() => [] as readonly Worktree[]),
      Effect.runPromise(
        listBranches({ connection: selectedOptions, projectId: effectiveProjectId }),
      ),
      Effect.runPromise(
        listPullRequests({ connection: selectedOptions, projectId: effectiveProjectId }),
      ),
    ]).then(([nextWorktrees, nextBranches, nextPrs]) => {
      if (cancelled) return;
      setWorktrees(nextWorktrees);
      setBranches(nextBranches);
      setPrs(nextPrs);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedOptions, effectiveProjectId]);

  const loading = Object.values(loadingByConnection).some(Boolean);
  const canSubmit =
    effectiveConnectionKey !== null &&
    selectedOptions !== null &&
    effectiveProjectId !== null &&
    text.trim().length > 0 &&
    !submitting;

  const submit = useCallback(async () => {
    const payload = buildNewChatCreatePayload({
      connectionKey: effectiveConnectionKey,
      projectId: effectiveProjectId,
      providerId: modelMode.providerId,
      model: modelMode.model,
      runtimeMode: modelMode.runtimeMode,
      permissionMode: modelMode.permissionMode,
      source,
      text,
    });
    if (payload === null || effectiveConnectionKey === null || selectedOptions === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const worktreeId =
        payload.createSource === null
          ? payload.worktreeId
          : (
              await Effect.runPromise(
                createWorktree({
                  connection: selectedOptions,
                  projectId: payload.projectId,
                  source: payload.createSource,
                }),
              )
            ).id;
      const result = await createChat(effectiveConnectionKey, selectedOptions, {
        projectId: payload.projectId,
        providerId: payload.providerId,
        model: payload.model,
        initialPrompt: payload.initialPrompt,
        runtimeMode: payload.runtimeMode,
        permissionMode: payload.permissionMode,
        worktreeId,
      });
      router.replace(
        `/c/${encodeURIComponent(effectiveConnectionKey)}/session/${encodeURIComponent(
          result.initialSession.id,
        )}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }, [
    createChat,
    modelMode,
    effectiveConnectionKey,
    selectedOptions,
    effectiveProjectId,
    source,
    text,
  ]);

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <Stack.Screen options={{ title: "New Chat" }} />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 164, gap: 18 }}
      >
        <View className="gap-2 pt-2">
          <Text className="font-sans-bold text-[32px] leading-9 text-foreground">
            What should we build?
          </Text>
          <Text className="font-sans text-[15px] leading-6 text-muted-foreground">
            Pick the project, model, and branch source before starting.
          </Text>
        </View>

        <Section title="Computer">
          {connections.map((connection) => (
            <ChoiceRow
              key={connection.key}
              title={connection.label}
              detail={connection.host}
              selected={connection.key === effectiveConnectionKey}
              onPress={() => {
                setSelectedConnectionKey(connection.key);
                setSelectedProjectId(null);
                setSource(MAIN_SOURCE);
              }}
            />
          ))}
          {connections.length === 0 ? (
            <EmptyLine text="No linked computers found." />
          ) : null}
        </Section>

        <Section title="Project">
          {projectChoices.map((item) => (
            <ChoiceRow
              key={item.project.id}
              title={item.project.name}
              detail={item.project.path}
              selected={item.project.id === effectiveProjectId}
              onPress={() => {
                setSelectedProjectId(item.project.id);
                setSource(MAIN_SOURCE);
              }}
            />
          ))}
          {projectChoices.length === 0 ? (
            <EmptyLine text={loading ? "Loading projects..." : "No projects found."} />
          ) : null}
        </Section>

        <Section title="Source">
          <ChoiceRow
            title="Main checkout"
            detail="Start from the default project checkout"
            selected={source.kind === "main"}
            icon="main"
            onPress={() => setSource(MAIN_SOURCE)}
          />
          {worktrees.slice(0, 6).map((worktree) => (
            <ChoiceRow
              key={worktree.id}
              title={worktree.branch}
              detail={`${worktree.name} / ${worktree.setupStatus}`}
              selected={source.kind === "worktree" && source.worktreeId === worktree.id}
              icon="branch"
              onPress={() =>
                setSource({
                  kind: "worktree",
                  label: worktree.branch,
                  worktreeId: worktree.id,
                })
              }
            />
          ))}
          {branches
            .filter((branch) => !branch.current)
            .slice(0, 6)
            .map((branch) => (
              <ChoiceRow
                key={`${branch.kind}:${branch.name}`}
                title={branch.name}
                detail={branch.kind === "remote" ? "Remote branch" : "Local branch"}
                selected={source.kind === "branch" && source.label === branch.name}
                icon="branch"
                onPress={() =>
                  setSource({
                    kind: "branch",
                    label: branch.name,
                    worktreeId: null,
                    createSource: {
                      _tag: "branch",
                      branch: branch.name,
                      remote: branch.remote,
                    },
                  })
                }
              />
            ))}
          {prs.slice(0, 6).map((pr) => (
            <ChoiceRow
              key={`pr:${pr.number}`}
              title={`#${pr.number} ${pr.title}`}
              detail={pr.headRefName}
              selected={source.kind === "pr" && source.label === `#${pr.number}`}
              icon="pr"
              onPress={() =>
                setSource({
                  kind: "pr",
                  label: `#${pr.number}`,
                  worktreeId: null,
                  createSource: {
                    _tag: "pr",
                    number: pr.number,
                    headRefName: pr.headRefName,
                  },
                })
              }
            />
          ))}
        </Section>

        {error === null ? null : (
          <Text selectable className="font-sans text-[13px] leading-5 text-danger">
            {error}
          </Text>
        )}
      </ScrollView>

      <View
        className="border-t border-border px-3 pt-3"
        style={{ paddingBottom: insets.bottom > 0 ? insets.bottom : 12 }}
      >
        <GlassSurface
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 8,
            padding: 8,
          }}
        >
          <View className="min-w-0 flex-1 gap-2">
            <ModelModeTrigger
              value={modelMode}
              editable
              open={modelSheetOpen}
              onOpenChange={setModelSheetOpen}
              onChange={setModelMode}
            />
            <TextInput
              className="min-h-10 px-2 py-2 font-sans text-[17px] text-foreground"
              multiline
              placeholder="Message"
              placeholderTextColor="hsl(72 4% 56%)"
              value={text}
              onChangeText={setText}
            />
          </View>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onPress={() => void submit()}
          >
            {submitting ? (
              <ActivityIndicator color="hsl(72 5% 6%)" />
            ) : selectedOptions === null ? (
              <CloudOff size={16} color="hsl(72 5% 6%)" />
            ) : (
              <Send size={16} color="hsl(72 5% 6%)" />
            )}
          </Button>
        </GlassSurface>
      </View>
    </KeyboardAvoidingView>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text className="px-1 font-sans-medium text-[12px] uppercase text-muted-foreground">
        {title}
      </Text>
      <View
        className="overflow-hidden rounded-2xl border border-border bg-card"
        style={{ borderCurve: "continuous" }}
      >
        {children}
      </View>
    </View>
  );
}

function ChoiceRow({
  title,
  detail,
  selected,
  icon,
  onPress,
}: {
  title: string;
  detail: string;
  selected: boolean;
  icon?: "main" | "branch" | "pr";
  onPress: () => void;
}) {
  const Icon =
    icon === "branch" ? GitBranch : icon === "pr" ? GitPullRequest : Layers3;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="min-h-[58px] flex-row items-center gap-3 border-b border-border px-3 py-2 active:bg-card-elevated"
    >
      <Icon size={17} color={selected ? ACCENT : "hsl(72 2% 64%)"} />
      <View className="min-w-0 flex-1">
        <Text className="font-sans-medium text-[15px] text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="font-sans text-[12px] text-muted-foreground" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {selected ? <Check size={17} color={ACCENT} /> : null}
    </Pressable>
  );
}

const EmptyLine = ({ text }: { text: string }) => (
  <View className="px-3 py-4">
    <Text className="font-sans text-[13px] text-muted-foreground">{text}</Text>
  </View>
);
