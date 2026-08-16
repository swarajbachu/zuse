import { PtyDataEvent, PtyExitEvent } from "@zuse/contracts";

const utf8Encoder = new TextEncoder();

export type PtySequencedEvent =
  | typeof PtyDataEvent.Type
  | typeof PtyExitEvent.Type;

type ReplayResult =
  | {
      readonly _tag: "events";
      readonly events: ReadonlyArray<PtySequencedEvent>;
    }
  | {
      readonly _tag: "gap";
      readonly requestedAfter: number;
      readonly earliestAvailable: number;
      readonly latestAvailable: number;
    };

type JournalEntry = {
  readonly event: PtySequencedEvent;
  readonly bytes: number;
};

export class PtyEventJournal {
  private readonly entries: JournalEntry[] = [];
  private retainedBytes = 0;
  private sequence = 0;

  constructor(private readonly byteBudget: number) {}

  get latestSequence(): number {
    return this.sequence;
  }

  appendData(bytes: string): PtySequencedEvent {
    const event = PtyDataEvent.make({ sequence: ++this.sequence, bytes });
    this.append(event, utf8Encoder.encode(bytes).byteLength);
    return event;
  }

  appendExit(
    exitCode: number | null,
    signal: number | null,
  ): PtySequencedEvent {
    const event = PtyExitEvent.make({
      sequence: ++this.sequence,
      exitCode,
      signal,
    });
    this.append(event, 0);
    return event;
  }

  replay(afterSequence?: number): ReplayResult {
    const earliest = this.entries[0]?.event.sequence ?? this.sequence + 1;
    const requestedAfter = afterSequence ?? 0;
    if (requestedAfter < earliest - 1 && requestedAfter < this.sequence) {
      return {
        _tag: "gap",
        requestedAfter,
        earliestAvailable: earliest,
        latestAvailable: this.sequence,
      };
    }
    return {
      _tag: "events",
      events: this.entries
        .map((entry) => entry.event)
        .filter(
          (event) =>
            afterSequence === undefined || event.sequence > afterSequence,
        ),
    };
  }

  private append(event: PtySequencedEvent, bytes: number): void {
    this.entries.push({ event, bytes });
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.byteBudget && this.entries.length > 0) {
      const removed = this.entries.shift();
      if (removed !== undefined) this.retainedBytes -= removed.bytes;
    }
  }
}
