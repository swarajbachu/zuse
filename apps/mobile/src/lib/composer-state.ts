import type {
  PermissionMode,
  ProviderId,
  RuntimeMode,
  SessionStatus,
} from "@zuse/contracts";

export const isInterruptVisible = (status: SessionStatus | undefined): boolean =>
  status === "running" || status === "booting";

/** The four dimensions a model/mode selection can carry. */
export type ModelModeSelection = {
  providerId: ProviderId;
  model: string;
  runtimeMode: RuntimeMode;
  permissionMode: PermissionMode;
};

/** One RPC the composer should issue to reconcile a model/mode change. */
export type ModelChangeAction =
  | { type: "setProvider"; providerId: ProviderId; model: string }
  | { type: "setModel"; model: string }
  | { type: "setRuntimeMode"; runtimeMode: RuntimeMode }
  | { type: "setPermissionMode"; permissionMode: PermissionMode };

/**
 * Pure decision of which session RPCs to call when the user changes the
 * model/mode selection (D3):
 *  - Provider swaps are fresh-chat-only (server enforces via
 *    `SessionAlreadyStartedError`) — ignored mid-session.
 *  - A model change within the current provider is allowed anytime.
 *  - Runtime and permission mode changes are always issued when they differ;
 *    the server accepts or rejects them per session state.
 */
export const nextModelChangeActions = (
  session: ModelModeSelection,
  next: ModelModeSelection,
  fresh: boolean,
): ModelChangeAction[] => {
  const actions: ModelChangeAction[] = [];
  if (next.providerId !== session.providerId) {
    // Provider swap only on a fresh chat; otherwise ignore it (and the model
    // that came with it — it belongs to the other provider).
    if (fresh) {
      actions.push({
        type: "setProvider",
        providerId: next.providerId,
        model: next.model,
      });
    }
  } else if (next.model !== session.model) {
    actions.push({ type: "setModel", model: next.model });
  }
  if (next.runtimeMode !== session.runtimeMode) {
    actions.push({ type: "setRuntimeMode", runtimeMode: next.runtimeMode });
  }
  if (next.permissionMode !== session.permissionMode) {
    actions.push({
      type: "setPermissionMode",
      permissionMode: next.permissionMode,
    });
  }
  return actions;
};

export const isFreshChat = (messages: readonly { role?: string; content?: { _tag?: string } }[]): boolean =>
  !messages.some(
    (message) =>
      message.role === "user" ||
      message.content?._tag === "user" ||
      message.content?._tag === "user_rich",
  );
