import { describe, expect, it } from "vitest";

import { PtyEventJournal } from "../../src/pty/pty-event-journal.ts";

describe("PTY event journal", () => {
  it("assigns sequences and resumes strictly after a cursor", () => {
    const journal = new PtyEventJournal(1_024);
    journal.appendData("a");
    journal.appendData("b");
    journal.appendData("c");

    expect(journal.replay()).toMatchObject({
      _tag: "events",
      events: [
        { _tag: "data", sequence: 1, bytes: "a" },
        { _tag: "data", sequence: 2, bytes: "b" },
        { _tag: "data", sequence: 3, bytes: "c" },
      ],
    });
    expect(journal.replay(1)).toMatchObject({
      _tag: "events",
      events: [
        { sequence: 2, bytes: "b" },
        { sequence: 3, bytes: "c" },
      ],
    });
  });

  it("reports a gap instead of pretending truncated output is complete", () => {
    const journal = new PtyEventJournal(3);
    journal.appendData("aa");
    journal.appendData("bb");
    journal.appendData("cc");

    expect(journal.replay(1)).toEqual({
      _tag: "gap",
      requestedAfter: 1,
      earliestAvailable: 3,
      latestAvailable: 3,
    });
    expect(journal.replay(2)).toMatchObject({
      _tag: "events",
      events: [{ sequence: 3, bytes: "cc" }],
    });
  });

  it("drops a single event larger than the byte budget", () => {
    const journal = new PtyEventJournal(3);
    journal.appendData("oversized");

    expect(journal.replay(0)).toEqual({
      _tag: "gap",
      requestedAfter: 0,
      earliestAvailable: 2,
      latestAvailable: 1,
    });
  });

  it("retains exit metadata without charging it against the byte budget", () => {
    const journal = new PtyEventJournal(1);
    journal.appendData("x");
    journal.appendExit(7, null);

    expect(journal.replay(1)).toMatchObject({
      _tag: "events",
      events: [{ _tag: "exit", sequence: 2, exitCode: 7, signal: null }],
    });
  });
});
