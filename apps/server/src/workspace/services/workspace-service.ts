import { Context, type Effect } from "effect";

import {
  type Folder,
  type FolderId,
  type WorkspaceDuplicatePathError,
  type WorkspaceInvalidPathError,
  type WorkspaceNotFoundError,
} from "@zuse/contracts";

export interface WorkspaceServiceShape {
  readonly add: (
    path: string,
  ) => Effect.Effect<
    Folder,
    WorkspaceDuplicatePathError | WorkspaceInvalidPathError
  >;
  readonly list: () => Effect.Effect<ReadonlyArray<Folder>>;
  readonly remove: (
    folderId: FolderId,
  ) => Effect.Effect<void, WorkspaceNotFoundError>;
  readonly getSelected: () => Effect.Effect<FolderId | null>;
  readonly setSelected: (
    folderId: FolderId | null,
  ) => Effect.Effect<void>;
  readonly findById: (
    folderId: FolderId,
  ) => Effect.Effect<Folder | null>;
}

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  WorkspaceServiceShape
>()("memoize/WorkspaceService") {}
