import type { ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	DeviceBridgeAction,
	DeviceBridgeResult,
	DeviceBridgeStatus,
	DeviceCommand,
	DeviceCommandGrant,
} from "@zuse/contracts";
import { DEVICE_BRIDGE_VERSION } from "@zuse/contracts";
import {
	SUPERVISED_COMMAND_LEASE_MS,
	signalProcessGroup,
	spawnSupervisedCommand,
} from "../process/process-group.ts";
import {
	DevicePermissionAuthority,
	deviceGrantMatches,
} from "../provider/services/permission-service.ts";

export interface DevicePrincipal {
	readonly accountId: string;
	readonly workspaceId: string;
	readonly chatId: string;
	readonly chatTitle?: string;
	readonly sessionId: string;
	readonly grantEpoch: number;
	readonly actor: "runtime" | "user";
}
export interface DeviceIdentity {
	readonly linkKey: string;
	readonly deviceId: string;
	readonly deviceName: string;
	readonly homeDirectory: string;
	readonly connected: boolean;
}
export interface DeviceBridgeStorage {
	loadConfig(): Promise<{ linkKey: string; enabled: boolean } | null>;
	saveConfig(linkKey: string, enabled: boolean): Promise<void>;
	commands(): Promise<readonly DeviceCommand[]>;
	command(id: string): Promise<DeviceCommand | undefined>;
	saveCommand(command: DeviceCommand): Promise<void>;
	reserveCommand(command: DeviceCommand): Promise<boolean>;
	grants(): Promise<readonly DeviceCommandGrant[]>;
	saveGrant(grant: DeviceCommandGrant): Promise<void>;
	deleteGrant(id: string): Promise<void>;
	clearGrants(): Promise<void>;
}
const active = (command: DeviceCommand) =>
	command.state === "pending" || command.state === "running";
const LEASE_MS = SUPERVISED_COMMAND_LEASE_MS;
const OUTPUT_LIMIT = 1024 * 1024;
const MAX_ACTIVE = 4;

/** Desktop authority. All transitions serialize; a durable receipt precedes spawn. */
export class DeviceCommandBroker {
	private tail: Promise<unknown> = Promise.resolve();
	private queuedOperations = 0;
	private readonly running = new Map<
		string,
		{
			child: ChildProcess;
			command: DeviceCommand;
			lease: number;
			bytes: number;
		}
	>();
	private readonly pendingLeases = new Map<string, number>();
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;
	private disabled = false;
	private readonly permissions: DevicePermissionAuthority;
	constructor(
		private readonly storage: DeviceBridgeStorage,
		private readonly identity: () => Promise<DeviceIdentity>,
	) {
		this.permissions = new DevicePermissionAuthority(storage);
		this.timer = setInterval(() => {
			if (this.running.size || this.pendingLeases.size)
				void this.exclusive(() => this.sweep()).catch(() => this.killAll());
		}, 1000);
		this.timer.unref();
	}
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (this.queuedOperations >= 64)
			return Promise.reject(new Error("Device bridge is busy"));
		this.queuedOperations++;
		const result = this.tail.then(fn);
		this.tail = result.catch(() => {});
		return result.finally(() => {
			this.queuedOperations--;
		});
	}
	async initialize(): Promise<void> {
		for (const command of await this.storage.commands())
			if (active(command))
				await this.storage.saveCommand({ ...command, state: "unknown" });
		await this.synchronize();
	}
	private kill(id: string): void {
		const entry = this.running.get(id);
		if (entry) signalProcessGroup(entry.child, "SIGKILL");
		this.running.delete(id);
		this.pendingLeases.delete(id);
	}
	private killAll(): void {
		this.disabled = true;
		this.pendingLeases.clear();
		for (const id of this.running.keys()) this.kill(id);
	}
	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		this.killAll();
	}
	private async synchronize(): Promise<DeviceIdentity> {
		const identity = await this.identity();
		const config = await this.storage.loadConfig();
		if (
			config?.linkKey !== identity.linkKey ||
			(config.enabled && !identity.connected)
		) {
			for (const command of await this.storage.commands())
				if (active(command)) await this.stop(command, "interrupted");
			await this.permissions.clear();
			await this.storage.saveConfig(identity.linkKey, identity.connected);
			this.disabled = !identity.connected;
		}
		return identity;
	}
	private async sweep(): Promise<void> {
		await this.synchronize();
		const now = Date.now();
		for (const [id, lease] of this.pendingLeases)
			if (lease < now) {
				const command = await this.storage.command(id);
				if (command && active(command)) await this.stop(command, "interrupted");
			}
		for (const entry of this.running.values())
			if (entry.lease < now) await this.stop(entry.command, "interrupted");
	}
	private async stop(
		command: DeviceCommand,
		state: "cancelled" | "interrupted" | "denied",
	): Promise<DeviceCommand> {
		const latest = this.running.get(command.id)?.command ?? command;
		this.kill(command.id);
		const result = { ...latest, state };
		await this.storage.saveCommand(result);
		return result;
	}
	private async statusUnlocked(
		principal?: DevicePrincipal,
	): Promise<DeviceBridgeStatus> {
		const identity = await this.synchronize();
		const commands = (await this.storage.commands())
			.map((c) => this.running.get(c.id)?.command ?? c)
			.filter(
				(c) =>
					!principal ||
					(c.accountId === principal.accountId &&
						c.chatId === principal.chatId),
			);
		const grants = (await this.permissions.list()).filter(
			(g) =>
				!principal ||
				(g.accountId === principal.accountId &&
					(g.chatId === null || g.chatId === principal.chatId)),
		);
		return {
			version: DEVICE_BRIDGE_VERSION,
			deviceId: identity.deviceId,
			deviceName: identity.deviceName,
			homeDirectory: identity.homeDirectory,
			connected: identity.connected,
			enabled:
				!this.disabled && (await this.storage.loadConfig())?.enabled === true,
			commands: commands
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 20)
				.map((command) => ({
					...command,
					stdout: command.stdout.slice(-4096),
					stderr: command.stderr.slice(-4096),
				})),
			grants,
		};
	}
	status(): Promise<DeviceBridgeStatus> {
		return this.exclusive(() => this.statusUnlocked());
	}
	configure(enabled: boolean): Promise<DeviceBridgeStatus> {
		if (!enabled) {
			this.disabled = true;
			for (const entry of this.running.values())
				signalProcessGroup(entry.child, "SIGKILL");
		}
		return this.exclusive(async () => {
			const identity = await this.synchronize();
			if (enabled && !identity.connected)
				throw new Error(
					"Enable hosted device access and sign in on this desktop first.",
				);
			if (enabled && this.disabled) await this.permissions.clear();
			await this.storage.saveConfig(identity.linkKey, enabled);
			this.disabled = !enabled;
			if (!enabled) {
				await this.permissions.clear();
				for (const command of await this.storage.commands())
					if (active(command)) await this.stop(command, "cancelled");
			}
			return this.statusUnlocked();
		});
	}
	handle(
		action: DeviceBridgeAction,
		principal?: DevicePrincipal,
	): Promise<DeviceBridgeResult> {
		return this.exclusive(async () => {
			if (this.closed) throw new Error("Device bridge stopped");
			const identity = await this.synchronize();
			if (action._tag === "status") return this.statusUnlocked(principal);
			const enabled =
				!this.disabled && (await this.storage.loadConfig())?.enabled === true;
			if (!enabled && (action._tag === "execute" || action._tag === "decide"))
				throw new Error("Cloud agent access is disabled on this computer.");
			if (action._tag === "revoke") {
				if (principal?.actor === "runtime")
					throw new Error("User approval required");
				const grant = await this.permissions.revoke(
					action.id,
					principal?.accountId,
				);
				for (const command of await this.storage.commands())
					if (active(command) && deviceGrantMatches(grant, command))
						await this.stop(command, "cancelled");
				return this.statusUnlocked(principal);
			}
			const id = action._tag === "execute" ? action.input.id : action.id;
			if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
				throw new Error("Invalid command ID");
			let command = await this.storage.command(id);
			if (
				command &&
				principal &&
				(command.accountId !== principal.accountId ||
					command.workspaceId !== principal.workspaceId ||
					command.chatId !== principal.chatId)
			)
				throw new Error("Command not found");
			if (action._tag === "execute") {
				if (principal?.actor !== "runtime")
					throw new Error("Only cloud runtimes may request execution");
				if (command) {
					if (
						command.command !== action.input.command ||
						command.cwd !== action.input.cwd
					)
						throw new Error("Command ID was already used");
					return this.running.get(id)?.command ?? command;
				}
				if (
					!action.input.command.trim() ||
					action.input.command.length > 32768 ||
					action.input.command.includes("\0") ||
					!isAbsolute(action.input.cwd) ||
					action.input.cwd.length > 4096 ||
					action.input.cwd.includes("\0")
				)
					throw new Error(
						"A command and absolute local working directory are required",
					);
				if (this.running.size + this.pendingLeases.size >= MAX_ACTIVE)
					throw new Error("Computer is busy; four commands are already active");
				command = {
					...action.input,
					...principal,
					chatTitle: principal.chatTitle ?? principal.chatId,
					deviceId: identity.deviceId,
					deviceName: identity.deviceName,
					state: "pending",
					stdout: "",
					stderr: "",
					exitCode: null,
					truncated: false,
					createdAt: Date.now(),
				};
				const requested = command;
				if (!(await this.storage.reserveCommand(command)))
					throw new Error(
						"Command ID already exists; read its status instead of retrying execution",
					);
				this.pendingLeases.set(id, Date.now() + LEASE_MS);
				if (await this.permissions.allows(requested)) await this.start(command);
				return this.running.get(id)?.command ?? command;
			}
			if (!command) throw new Error("Command not found");
			if (action._tag === "poll" || action._tag === "lease") {
				const currentLease =
					this.running.get(id)?.lease ?? this.pendingLeases.get(id);
				if (
					active(command) &&
					(!enabled ||
						currentLease === undefined ||
						currentLease < Date.now() ||
						(principal && principal.grantEpoch !== command.grantEpoch))
				)
					return this.stop(command, "interrupted");
				if (principal?.actor === "runtime") {
					const entry = this.running.get(id);
					if (entry) {
						entry.lease = Date.now() + LEASE_MS;
						if (!entry.child.stdin?.write(`${entry.lease}\n`))
							signalProcessGroup(entry.child, "SIGKILL");
					}
					if (command.state === "pending")
						this.pendingLeases.set(id, Date.now() + LEASE_MS);
				}
				const result = this.running.get(id)?.command ?? command;
				return action._tag === "lease"
					? { ...result, stdout: "", stderr: "" }
					: result;
			}
			if (action._tag === "cancel")
				return active(command) ? this.stop(command, "cancelled") : command;
			if (principal?.actor === "runtime")
				throw new Error("User approval required");
			if (command.state !== "pending")
				throw new Error("This request has already been resolved");
			if ((this.pendingLeases.get(id) ?? 0) < Date.now())
				return this.stop(command, "interrupted");
			if (action.decision === "Deny") return this.stop(command, "denied");
			await this.permissions.remember(command, action.decision);
			await this.start(command);
			if (action.decision !== "AllowOnce") {
				for (const other of await this.storage.commands()) {
					if (
						other.id !== id &&
						other.state === "pending" &&
						(this.pendingLeases.get(other.id) ?? 0) >= Date.now() &&
						(await this.permissions.allows(other))
					)
						await this.start(other);
				}
			}
			return this.running.get(id)?.command ?? command;
		});
	}
	private async start(command: DeviceCommand): Promise<void> {
		if (this.disabled || this.closed)
			throw new Error("Cloud agent access is disabled");
		const lease = this.pendingLeases.get(command.id);
		if (lease === undefined || lease <= Date.now())
			throw new Error("Local command request expired");
		const started: DeviceCommand = { ...command, state: "running" };
		await this.storage.saveCommand(started);
		if (this.disabled || this.closed)
			throw new Error("Cloud agent access is disabled");
		this.pendingLeases.delete(command.id);
		// Detached process groups let cancellation stop descendants as well as the shell.
		const child = spawnSupervisedCommand(command.command, command.cwd, lease);
		const entry = {
			child,
			command: started,
			lease,
			bytes: 0,
		};
		this.running.set(command.id, entry);
		child.stdin?.on("error", () => signalProcessGroup(child, "SIGKILL"));
		for (const channel of ["stdout", "stderr"] as const) {
			const decoder = new StringDecoder("utf8");
			child[channel]?.on("data", (chunk: Buffer) => {
				const remaining = OUTPUT_LIMIT - entry.bytes;
				const text = decoder.write(chunk.subarray(0, Math.max(0, remaining)));
				entry.bytes += Math.min(chunk.length, Math.max(0, remaining));
				entry.command = {
					...entry.command,
					[channel]: entry.command[channel] + text,
					truncated: entry.command.truncated || chunk.length > remaining,
				};
			});
			child[channel]?.once("end", () => {
				const tail = decoder.end();
				if (!entry.command.truncated)
					entry.command = {
						...entry.command,
						[channel]: entry.command[channel] + tail,
					};
			});
		}

		const finish = (exitCode: number | null, error?: string) => {
			void this.exclusive(async () => {
				if (!this.running.has(command.id)) return;
				this.kill(command.id);
				await this.storage.saveCommand({
					...entry.command,
					state: error ? "interrupted" : "completed",
					exitCode,
					stderr: error
						? `${entry.command.stderr}\n${error}`
						: entry.command.stderr,
				});
			}).catch(() => this.kill(command.id));
		};
		child.once("error", (error) => finish(null, error.message));
		child.once("exit", () => signalProcessGroup(child, "SIGKILL"));
		child.once("close", (code, signal) =>
			finish(code, signal ? `Command interrupted by ${signal}` : undefined),
		);
	}
}
