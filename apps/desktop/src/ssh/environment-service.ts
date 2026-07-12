import {
  openTunnel,
  parseLaunchResult,
  readHostAliases,
  remoteLaunchScript,
  type TunnelHandle,
} from "@zuse/ssh";
import type { EnvironmentDescriptor } from "@zuse/contracts";
import { Effect } from "effect";
import { spawn } from "node:child_process";

export type SshEnvironmentHandle = {
  descriptor: EnvironmentDescriptor;
  tunnel: TunnelHandle;
  close: () => Promise<void>;
};

export const listSshHosts = (): Promise<readonly string[]> =>
  Effect.runPromise(readHostAliases());

export const ensureSshEnvironment = async (
  host: string,
): Promise<SshEnvironmentHandle> => {
  const launch = await launchRemoteServer(host);
  const tunnel = await Effect.runPromise(
    openTunnel({ host, remotePort: launch.remotePort }),
  );
  const descriptor = {
    environmentId: `ssh_${host}`,
    providerKind: "ssh",
    endpoint: {
      httpBaseUrl: `http://127.0.0.1:${tunnel.localPort}`,
      wsBaseUrl: tunnel.wsBaseUrl,
    },
    label: host,
  } as EnvironmentDescriptor;
  return {
    descriptor,
    tunnel,
    close: tunnel.close,
  };
};

const launchRemoteServer = async (host: string) => {
  const child = spawn("ssh", [host, "sh", "-s"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(remoteLaunchScript());
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const output = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/);
  if (code !== 0) {
    throw new Error(
      Buffer.concat(errors).toString("utf8") || `ssh exited with ${code}`,
    );
  }
  return parseLaunchResult(output.at(-1) ?? "");
};
