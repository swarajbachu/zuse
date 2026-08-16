import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { AuthService } from "./services/auth-service.ts";

/**
 * auth.* RPC handlers. `signIn` already fails with the wire errors
 * (`AuthFlowError` / `AuthCancelledError`), so unlike most domains there's no
 * internal→wire error mapping here. `getSession` never fails (folds to
 * SignedOut); `sessionChanges` is the broadcast the renderer subscribes to.
 */
const GetSession = MemoizeRpcs.toLayerHandler("auth.getSession", () =>
  Effect.flatMap(AuthService, (svc) => svc.getSession()),
);

const SignIn = MemoizeRpcs.toLayerHandler("auth.signIn", () =>
  Effect.flatMap(AuthService, (svc) => svc.signIn()),
);

const SignOut = MemoizeRpcs.toLayerHandler("auth.signOut", () =>
  Effect.flatMap(AuthService, (svc) => svc.signOut()),
);

const SessionChanges = MemoizeRpcs.toLayerHandler("auth.sessionChanges", () =>
  Stream.unwrap(Effect.map(AuthService, (svc) => svc.sessionChanges())),
);

export const AuthHandlersLayer = Layer.mergeAll(
  GetSession,
  SignIn,
  SignOut,
  SessionChanges,
);
