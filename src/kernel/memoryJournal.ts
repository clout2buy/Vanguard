import type { JournalPort, RunEvent } from "./contracts.js";

export class MemoryJournal implements JournalPort {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(event);
  }

  async readValidated(): Promise<readonly RunEvent[]> {
    return this.events;
  }
}
