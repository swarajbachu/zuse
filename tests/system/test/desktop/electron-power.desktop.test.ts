import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { installFakeAcpProvider } from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { launchElectronApp } from "../../src/electron-app.ts";
import { withSystemTest } from "../../src/system-scope.ts";

describe("Electron performance measurement bridge", () => {
	it("samples locally, records on demand, and removes renderer subscriptions", async () => {
		await withSystemTest("zuse-electron-power-", async (scope) => {
			const userData = scope.path("user-data");
			mkdirSync(userData, { recursive: true });
			const server = await scope.server();
			const rpc = await scope.rpc(server.endpoint);
			await Effect.runPromise(
				rpc.client["settings.update"]({
					patch: { onboardingCompleted: true },
				}),
			);
			await rpc.dispose();
			await server.stop();
			const provider = installFakeAcpProvider({ root: scope.root });
			const electron = await scope.acquire(
				() =>
					launchElectronApp({
						root: scope.root,
						userData,
						providerBinDirectory: provider.binDirectory,
					}),
				(value) => value.close(),
			);

			const readCumulativeCpuSeconds = () =>
				electron.app.evaluate(({ app }) =>
					app
						.getAppMetrics()
						.reduce(
							(total, metric) => total + (metric.cpu.cumulativeCPUUsage ?? 0),
							0,
						),
				);
			const beforeCpuSeconds = await readCumulativeCpuSeconds();
			const overheadIterations = 40;
			await electron.page.evaluate(async (iterations) => {
				const target = window as typeof window & {
					zuse?: {
						power?: {
							onState: (
								handler: (
									state: import("@zuse/contracts").PowerMonitorState,
								) => void,
							) => () => void;
							startRecording: (duration: 5 | 15 | 30) => Promise<unknown>;
							stopRecording: () => Promise<unknown>;
							reportWorkload: (
								workload: import("@zuse/contracts").PowerWorkloadState,
							) => void;
						};
					};
				};
				const power = target.zuse?.power;
				if (power === undefined) throw new Error("power bridge missing");
				let events = 0;
				const unsubscribe = power.onState(() => {
					events += 1;
				});
				await power.startRecording(5);
				for (let index = 0; index < iterations; index += 1) {
					power.reportWorkload({
						activeAgents: index % 2,
						activeTerminals: 0,
						browserSessions: 0,
						activeBrowserSessions: 0,
						browserRecordings: 0,
						indexing: false,
					});
				}
				const deadline = Date.now() + 10_000;
				while (events < iterations && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				unsubscribe();
				await power.stopRecording();
				if (events < iterations) {
					throw new Error(
						`Only ${events}/${iterations} monitor updates completed.`,
					);
				}
			}, overheadIterations);
			const usedCpuSeconds = Math.max(
				0,
				(await readCumulativeCpuSeconds()) - beforeCpuSeconds,
			);
			// Burst the complete sampling → aggregation → IPC → renderer callback
			// path, then amortize its measured CPU time at the production cadence.
			const samplingOverhead = {
				normalCpuPercent: (usedCpuSeconds / (overheadIterations * 15)) * 100,
				recordingCpuPercent: (usedCpuSeconds / (overheadIterations * 5)) * 100,
			};
			expect(samplingOverhead.normalCpuPercent).toBeLessThan(0.5);
			expect(samplingOverhead.recordingCpuPercent).toBeLessThan(2);

			const result = await electron.page.evaluate(async () => {
				const target = window as typeof window & {
					zuse?: {
						power?: {
							getState: () => Promise<
								import("@zuse/contracts").PowerMonitorState
							>;
							onState: (
								handler: (
									state: import("@zuse/contracts").PowerMonitorState,
								) => void,
							) => () => void;
							startRecording: (
								duration: 5 | 15 | 30,
							) => Promise<import("@zuse/contracts").PowerMonitorState>;
							stopRecording: () => Promise<
								import("@zuse/contracts").PowerMonitorState
							>;
							exportLatestRecording: (
								interactions: ReadonlyArray<
									import("@zuse/contracts").PowerInteractionMeasurement
								>,
							) => Promise<import("@zuse/contracts").PowerExportResult | null>;
						};
					};
				};
				const power = target.zuse?.power;
				if (power === undefined) throw new Error("power bridge missing");
				const initial = await power.getState();
				let firstEvents = 0;
				let secondEvents = 0;
				const unsubscribeFirst = power.onState(() => {
					firstEvents += 1;
				});
				const unsubscribeSecond = power.onState(() => {
					secondEvents += 1;
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				unsubscribeFirst();
				const firstEventsAtUnsubscribe = firstEvents;
				const secondEventsBeforeRecording = secondEvents;
				const active = await power.startRecording(5);
				const secondEventsAfterFirstUnsubscribe =
					secondEvents - secondEventsBeforeRecording;
				unsubscribeSecond();
				const secondEventsAtUnsubscribe = secondEvents;
				const completed = await power.stopRecording();
				await new Promise((resolve) => setTimeout(resolve, 25));
				return {
					hasInitialSnapshot: initial.latestSnapshot !== null,
					active: active.activeRecording !== null,
					completed: completed.latestRecording !== null,
					sampleCount: completed.latestRecording?.summary.sampleCount ?? 0,
					firstEventsAfterUnsubscribe: firstEvents - firstEventsAtUnsubscribe,
					secondEventsAfterFirstUnsubscribe,
					secondEventsAfterUnsubscribe:
						secondEvents - secondEventsAtUnsubscribe,
				};
			});

			expect(result).toMatchObject({
				hasInitialSnapshot: true,
				active: true,
				completed: true,
				sampleCount: 1,
				firstEventsAfterUnsubscribe: 0,
				secondEventsAfterUnsubscribe: 0,
			});
			expect(result.secondEventsAfterFirstUnsubscribe).toBeGreaterThan(0);

			const recordingDeadline = Date.now() + 5_000;
			while (
				!readdirSync(userData, { recursive: true }).some((entry) =>
					String(entry).includes("performance-recordings"),
				) &&
				Date.now() < recordingDeadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(
				readdirSync(userData, { recursive: true }).some((entry) =>
					String(entry).includes("performance-recordings"),
				),
			).toBe(true);
			const exportDirectory = scope.path("performance-export");
			mkdirSync(exportDirectory, { recursive: true });
			await electron.app.evaluate(({ dialog }, directory) => {
				Object.defineProperty(dialog, "showOpenDialog", {
					configurable: true,
					value: async () => ({
						canceled: false,
						filePaths: [directory],
					}),
				});
			}, exportDirectory);
			const exported = await electron.page.evaluate(async () => {
				const target = window as typeof window & {
					zuse?: {
						power?: {
							exportLatestRecording: (
								interactions: ReadonlyArray<
									import("@zuse/contracts").PowerInteractionMeasurement
								>,
							) => Promise<import("@zuse/contracts").PowerExportResult | null>;
						};
					};
				};
				const power = target.zuse?.power;
				if (power === undefined) throw new Error("power bridge missing");
				const now = new Date().toISOString();
				return power.exportLatestRecording([
					{
						recordedAt: now,
						name: "chat.provider-ready",
						durationMs: 120,
					},
					{
						recordedAt: now,
						name: "chat.prompt-/Users/private/repository",
						durationMs: 1,
					},
				]);
			});
			expect(exported).not.toBeNull();
			expect(existsSync(exported?.jsonPath ?? "")).toBe(true);
			expect(existsSync(exported?.markdownPath ?? "")).toBe(true);
			const json = readFileSync(exported?.jsonPath ?? "", "utf8");
			expect(json).toContain("chat.provider-ready");
			expect(json).not.toContain("/Users/private/repository");
			expect(electron.errors).toEqual([]);
		});
	}, 45_000);
});
