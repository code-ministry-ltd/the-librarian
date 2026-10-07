// The eval run engine. For each fixture entry it stands up an in-memory corpus,
// runs the real pipeline (navigate→judge, then the unified D13 apply rule) with
// an injected LlmClient, and scores the plan. Deterministic: the recall adapter
// ranks by lexical overlap (stable tie-break by corpus order), and the ToC
// carries the whole (small) corpus, so the judge always has every candidate
// available.
//
// Never throws on a model/judge failure — a thrown LLM client or an unparseable
// judgment lands as a graded miss, so one bad case can't abort the run.

import {
  type IntakeJudgment,
  type LlmClient,
  type Memory,
  decideApplication,
  DEFAULT_APPLY_CONFIDENCE_THRESHOLD,
  INTAKE_OPERATION_OF,
  judgeSubmission,
  navigateInbox,
} from "@librarian/core";
import type { IntakeCorpusDoc, IntakeFixtureEntry } from "./fixture.js";
import {
  type EvalReport,
  type RoutedPlan,
  type SampleResult,
  scoreSample,
  summarize,
} from "./metrics.js";

export interface RunIntakeEvalOptions {
  fixture: IntakeFixtureEntry[];
  llmClient: LlmClient;
  /** The single D13 confidence threshold; defaults to the shipped 0.8. */
  threshold?: number;
  /**
   * The intake examples document (proposal-review rework F4/D7), threaded into
   * the judge prompt exactly as production does — so the eval measures the
   * curator WITH its teaching material when supplied.
   */
  intakeExamples?: string;
}

// Derive the D13 verdict for a judgment the way the apply layer would, using
// the apply layer's own action→operation mapping (INTAKE_OPERATION_OF): only the
// operation type + the single threshold drive the verdict (ADR 0014).
function routePlan(judgment: IntakeJudgment, threshold: number): RoutedPlan {
  return {
    decision: decideApplication({
      operation: INTAKE_OPERATION_OF[judgment.action],
      confidence: judgment.confidence,
      threshold,
    }),
    judgment,
  };
}

function corpusDocToMemory(doc: IntakeCorpusDoc): Memory {
  return {
    id: doc.id,
    agent_id: "system-eval",
    title: doc.title,
    body: doc.body,
    status: "active",
    confidence: "working",
    tags: doc.tags,
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    is_global: false,
    requires_approval: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

// A deterministic stand-in for index recall: rank the corpus by lexical overlap
// with the query, stable on ties by original order.
function rankByOverlap(memories: Memory[], query: string): Memory[] {
  const queryTokens = tokenize(query);
  return memories
    .map((memory, index) => ({
      memory,
      index,
      score: overlap(queryTokens, tokenize(`${memory.title} ${memory.body}`)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((ranked) => ranked.memory);
}

async function evaluateEntry(
  entry: IntakeFixtureEntry,
  llmClient: LlmClient,
  threshold: number,
  intakeExamples?: string,
): Promise<SampleResult> {
  const memories = entry.corpus.map(corpusDocToMemory);
  const deps = {
    recall: async (query: string, limit: number) => rankByOverlap(memories, query).slice(0, limit),
    listActive: () => memories,
  };
  try {
    const evidence = await navigateInbox(entry.submission.text, deps);
    const result = await judgeSubmission(
      {
        submissionText: entry.submission.text,
        evidence,
        ...(intakeExamples ? { intakeExamples } : {}),
      },
      { llmClient },
    );
    return scoreSample(
      entry,
      result.judgment ? routePlan(result.judgment, threshold) : null,
      result.parseError,
    );
  } catch (error) {
    return scoreSample(entry, null, (error as Error).message);
  }
}

export async function runIntakeEval(options: RunIntakeEvalOptions): Promise<EvalReport> {
  const threshold = options.threshold ?? DEFAULT_APPLY_CONFIDENCE_THRESHOLD;
  const samples: SampleResult[] = [];
  for (const entry of options.fixture) {
    samples.push(await evaluateEntry(entry, options.llmClient, threshold, options.intakeExamples));
  }
  return summarize(samples);
}
