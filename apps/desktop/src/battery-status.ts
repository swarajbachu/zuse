import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BatteryStatus {
	readonly percent: number | null;
	readonly isCharging: boolean | null;
}

const unknownBatteryStatus = (): BatteryStatus => ({
	percent: null,
	isCharging: null,
});

const normalizedPercent = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value)
		? Math.min(100, Math.max(0, value))
		: null;

export function parseMacOsBatteryStatus(output: string): BatteryStatus {
	const percent = normalizedPercent(
		Number(/(\d+(?:\.\d+)?)%/.exec(output)?.[1]),
	);
	const normalized = output.toLowerCase();
	const isCharging = normalized.includes("discharging")
		? false
		: normalized.includes("charging") || normalized.includes("charged")
			? true
			: null;
	return { percent, isCharging };
}

export function parseWindowsBatteryStatus(output: string): BatteryStatus {
	try {
		const parsed = JSON.parse(output) as {
			readonly EstimatedChargeRemaining?: unknown;
			readonly BatteryStatus?: unknown;
		};
		const percent = normalizedPercent(parsed.EstimatedChargeRemaining);
		const status =
			typeof parsed.BatteryStatus === "number" ? parsed.BatteryStatus : null;
		const isCharging =
			status === null
				? null
				: [2, 3, 6, 7, 8, 9, 11].includes(status)
					? true
					: [1, 4, 5].includes(status)
						? false
						: null;
		return { percent, isCharging };
	} catch {
		return unknownBatteryStatus();
	}
}

const readLinuxBatteryStatus = async (): Promise<BatteryStatus> => {
	const root = "/sys/class/power_supply";
	const entries = await readdir(root);
	const battery = entries.find((entry) => /^BAT/i.test(entry));
	if (battery === undefined) return unknownBatteryStatus();
	const [capacity, status] = await Promise.all([
		readFile(`${root}/${battery}/capacity`, "utf8").catch(() => ""),
		readFile(`${root}/${battery}/status`, "utf8").catch(() => ""),
	]);
	const percent = normalizedPercent(Number(capacity.trim()));
	const normalized = status.trim().toLowerCase();
	return {
		percent,
		isCharging:
			normalized === "charging" || normalized === "full"
				? true
				: normalized === "discharging"
					? false
					: null,
	};
};

export async function readBatteryStatus(
	platform: NodeJS.Platform = process.platform,
): Promise<BatteryStatus> {
	try {
		if (platform === "darwin") {
			const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], {
				timeout: 2_000,
			});
			return parseMacOsBatteryStatus(stdout);
		}
		if (platform === "win32") {
			const { stdout } = await execFileAsync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
				],
				{ timeout: 3_000, windowsHide: true },
			);
			return parseWindowsBatteryStatus(stdout);
		}
		if (platform === "linux") return await readLinuxBatteryStatus();
	} catch {
		// Battery telemetry is optional and never affects desktop startup.
	}
	return unknownBatteryStatus();
}
