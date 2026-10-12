// Intake — the judge step's LLM half (spec 035 §F5). Builds the prompt via the
// unified curator prompt module (curator-prompt.ts, rethink T8) in intake mode,
// calls the injected LLM, and parses its judgment via the pure judge layer
// (judge.ts). The apply layer routes the judgment through the ONE D13 decision
// function. The LLM client is injected, so this is testable without a network.
//
// The submission + candidate evidence is UNTRUSTED — the prompt module redacts
// it before it reaches the provider, and the system contract is fixed so an
// injected addendum or prompt-injection can't relax the output schema or the
// rules the code re-enforces afterwards.

import { buildCuratorPrompt } from "../curator-prompt.js";
import type { LlmClient } from "../grooming-llm-client.js";
import { type IntakeJudgment, parseIntakeJudgment } from "./judge.js";
import type { IntakeCandidates } from "./navigate.js";

export interface JudgeSubmissionInput {
  submissionText: string;
  evidence: IntakeCandidates;
  /** Optional operator steering — redacted + framed as advisory only. */
  promptAddendum?: string;
  /** The intake examples doc (F4/D7) — inlined whole when non-empty, redacted. */
  intakeExamples?: string;
  /**
   * Why the previous judgment for this submission was refused (spec 075 §4.3) —
   * a fixed guard string naming the refused action; present only on the retry.
   */
  guardFeedback?: string;
}

export interface JudgeSubmissionDeps {
  llmClient: LlmClient;
}

export interface JudgeSubmissionResult {
  judgment?: IntakeJudgment;
  /** Set when the model output was unusable; the caller leaves the item for retry / logs it. */
  parseError?: string;
}

/** Run the judge step over one submission: prompt → LLM → parse. */
export async function judgeSubmission(
  input: JudgeSubmissionInput,
  deps: JudgeSubmissionDeps,
): Promise<JudgeSubmissionResult> {
  const messages = buildCuratorPrompt({
    mode: "intake",
    submissionText: input.submissionText,
    evidence: input.evidence,
    ...(input.promptAddendum !== undefined ? { promptAddendum: input.promptAddendum } : {}),
    ...(input.intakeExamples !== undefined ? { intakeExamples: input.intakeExamples } : {}),
    ...(input.guardFeedback !== undefined ? { guardFeedback: input.guardFeedback } : {}),
  });
  const completion = await deps.llmClient.complete({ messages });
  const parsed = parseIntakeJudgment(completion.content);
  if (!parsed.judgment) return { parseError: parsed.parseError ?? "no judgment" };
  return { judgment: parsed.judgment };
}
