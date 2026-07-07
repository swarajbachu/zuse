import { describe, expect, test } from "bun:test";

import {
  actionsJobsApiPath,
  collectActionsRunIds,
  metadataForRollupEntry,
  parseActionsCheckUrl,
  parseActionsJobsResponse,
} from "../src/git/check-runs.ts";

describe("git check run helpers", () => {
  test("parses GitHub Actions run and job ids from check URLs", () => {
    expect(
      parseActionsCheckUrl(
        "https://github.com/acme/app/actions/runs/123456/job/7890",
      ),
    ).toEqual({ runId: "123456", jobId: "7890" });
    expect(
      parseActionsCheckUrl("https://github.com/acme/app/actions/runs/123456"),
    ).toEqual({ runId: "123456", jobId: null });
    expect(parseActionsCheckUrl("https://ci.example.com/build/1")).toBeNull();
  });

  test("builds the workflow jobs API path", () => {
    expect(actionsJobsApiPath("acme", "app", "123")).toBe(
      "/repos/acme/app/actions/runs/123/jobs?per_page=100",
    );
  });

  test("collects unique Actions run ids and ignores external checks", () => {
    expect(
      collectActionsRunIds([
        {
          name: "test",
          detailsUrl: "https://github.com/acme/app/actions/runs/1/job/2",
        },
        {
          name: "build",
          detailsUrl: "https://github.com/acme/app/actions/runs/1/job/3",
        },
        { name: "external", targetUrl: "https://ci.example.com/build/4" },
      ]),
    ).toEqual(["1"]);
  });

  test("parses job responses defensively", () => {
    expect(
      parseActionsJobsResponse(
        JSON.stringify({ jobs: [{ id: 10, name: "test" }] }),
      ),
    ).toEqual([{ id: 10, name: "test" }]);
    expect(parseActionsJobsResponse("not json")).toEqual([]);
  });

  test("matches job metadata by job id and falls back for external checks", () => {
    const metadata = metadataForRollupEntry(
      {
        name: "test",
        detailsUrl: "https://github.com/acme/app/actions/runs/1/job/10",
      },
      new Map([
        [
          "1",
          [
            {
              id: 10,
              name: "test",
              workflow_name: "CI",
              runner_name: "ubuntu-24.04",
              runner_group_name: "GitHub Actions",
              started_at: "2026-07-07T10:00:00Z",
              completed_at: "2026-07-07T10:02:00Z",
            },
          ],
        ],
      ]),
    );
    expect(metadata.workflowName).toBe("CI");
    expect(metadata.runId).toBe("1");
    expect(metadata.jobId).toBe("10");
    expect(metadata.runnerName).toBe("ubuntu-24.04");
    expect(metadata.runnerGroupName).toBe("GitHub Actions");
    expect(metadata.startedAt?.toISOString()).toBe("2026-07-07T10:00:00.000Z");
    expect(metadata.completedAt?.toISOString()).toBe(
      "2026-07-07T10:02:00.000Z",
    );
    expect(metadata.runUrl).toBe("https://github.com/acme/app/actions/runs/1");

    expect(
      metadataForRollupEntry(
        { name: "external", targetUrl: "https://ci.example.com/build/1" },
        new Map(),
      ),
    ).toEqual({
      workflowName: null,
      runId: null,
      jobId: null,
      runnerName: null,
      runnerGroupName: null,
      startedAt: null,
      completedAt: null,
      runUrl: null,
    });
  });
});
