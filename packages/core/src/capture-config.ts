// The transcript-capture gate: is anything going to use a captured conversation?
//
// Two independent jobs read captured conversations (the transcript settle-sweep runs
// both): curator INTAKE mines them for memories, and the JOURNAL writes a dated
// episode. Capture is on while EITHER is on. With both off, POST /transcript refuses
// and buffers nothing, and the sweep does nothing — no raw conversation text sits at
// rest unless a switch that uses it is on.

import { isIntakeEnabled } from "./intake-config.js";
import { isJournalActive } from "./journal/config.js";
import type { LlmConnectionReader } from "./llm-connection.js";

/** True while curator intake or the journal is on. Fail-soft: a read error is "off". */
export function isCaptureEnabled(store: LlmConnectionReader): boolean {
  try {
    return isIntakeEnabled(store) || isJournalActive(store);
  } catch {
    return false;
  }
}
