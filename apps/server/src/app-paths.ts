import { Context } from "effect";

/**
 * OS-resolved paths the server needs at runtime. The Electron shim provides
 * the live values from `app.getPath("userData")`; a future headless server
 * would resolve them from `XDG_DATA_HOME` or similar. Services yield this tag
 * instead of importing electron themselves — that's the rule from ADR 0007.
 */
export class AppPaths extends Context.Service<
  AppPaths,
  {
    readonly userData: string;
  }
>()("memoize/AppPaths") {}
