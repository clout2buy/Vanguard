import type { JsonValue, RunEventType } from "../kernel/contracts.js";
import type { FileJournal } from "../kernel/fileJournal.js";

export async function appendSessionEvent(
  journal: FileJournal,
  type: RunEventType,
  data: JsonValue,
): Promise<void> {
  const tip = await journal.tip();
  await journal.append({ sequence: tip.sequence + 1, type, data });
}
