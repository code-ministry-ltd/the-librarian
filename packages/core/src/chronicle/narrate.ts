import { z } from "zod";
import type { LlmClient, LlmUsage } from "../grooming-llm-client.js";
import { redactSecrets } from "../grooming-redaction.js";
import { sanitizeChronicleMarkdown } from "./sanitize-markdown.js";
import type { ChronicleFacts, ChronicleNarrative } from "./types.js";

const MAX_FACTS_CHARS = 80_000;

const narrativeSchema = z.strictObject({
  headline: z.string().trim().min(1).max(500),
  narrative_md: z.string().trim().min(1).max(10_000),
  blog_seeds: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        angle: z.string().trim().min(1).max(1_000),
        sources: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      }),
    )
    .max(3),
});

export interface ChronicleNarrationResult {
  status: "generated" | "failed";
  narrative: ChronicleNarrative | null;
  model: string | null;
  usage: LlmUsage | null;
  error: "llm_error" | "malformed_output" | null;
  redactionCount: number;
}

export async function narrateChronicle(
  facts: ChronicleFacts,
  llm: LlmClient,
): Promise<ChronicleNarrationResult> {
  // Redact the COMPLETE serialized record before applying the provider-bound prompt cap. A secret
  // spanning the cap boundary must become a marker, never a leaked prefix (the C3 invariant).
  const fieldRedaction = redactValue(facts);
  const serializedRedaction = redactSecrets(JSON.stringify(fieldRedaction.value));
  const redactionCount = fieldRedaction.count + serializedRedaction.count;
  const truncated = serializedRedaction.redacted.length > MAX_FACTS_CHARS;
  const boundedFacts = serializedRedaction.redacted.slice(0, MAX_FACTS_CHARS);
  const messages = [
    {
      role: "system" as const,
      content:
        "You narrate a weekly Chronicle from supplied evidence. Return one JSON object only: " +
        '{"headline":string,"narrative_md":string,"blog_seeds":[{"title":string,"angle":string,"sources":string[]}]}. ' +
        "Ground every claim in the facts, cite vault paths or handoff ids inline, never invent work, " +
        "and return at most three blog seeds. Every blog seed source must exactly copy a vault path, " +
        "memory id, or handoff id present in the supplied facts. Seeds are angles and pointers, not " +
        "draft articles. Do not emit Markdown images, embeds, or raw HTML.",
    },
    {
      role: "user" as const,
      content:
        `Chronicle facts (redacted JSON${truncated ? "; bounded excerpt" : ""}):\n` + boundedFacts,
    },
  ];

  let completion: Awaited<ReturnType<LlmClient["complete"]>>;
  try {
    completion = await llm.complete({
      messages,
      jsonResponse: true,
      temperature: 0.2,
      // The Chronicle job's output limit on the client governs (thinking included).
    });
  } catch {
    return failed("llm_error", redactionCount);
  }

  try {
    const parsed = narrativeSchema.parse(JSON.parse(stripCodeFence(completion.content)));
    const allowedSources = chronicleSources(facts);
    if (
      parsed.blog_seeds.some((seed) => seed.sources.some((source) => !allowedSources.has(source)))
    ) {
      throw new Error("blog seed cited a source absent from Chronicle facts");
    }
    return {
      status: "generated",
      narrative: {
        headline: sanitizeChronicleMarkdown(parsed.headline),
        narrativeMd: sanitizeChronicleMarkdown(parsed.narrative_md),
        blogSeeds: parsed.blog_seeds.map((seed) => ({
          title: sanitizeChronicleMarkdown(seed.title),
          angle: sanitizeChronicleMarkdown(seed.angle),
          sources: seed.sources,
        })),
      },
      model: completion.model,
      usage: completion.usage,
      error: null,
      redactionCount,
    };
  } catch {
    return {
      ...failed("malformed_output", redactionCount),
      model: completion.model,
      usage: completion.usage,
    };
  }
}

function chronicleSources(facts: ChronicleFacts): Set<string> {
  const sources = new Set<string>();
  for (const commit of facts.commits.entries) {
    for (const file of commit.files) sources.add(file);
    for (const rename of commit.renames) {
      sources.add(rename.from);
      sources.add(rename.to);
    }
  }
  for (const memory of [
    ...facts.memories.created,
    ...facts.memories.updated,
    ...facts.memories.archived,
  ]) {
    sources.add(memory.id);
  }
  for (const handoff of [
    ...facts.handoffs.created,
    ...facts.handoffs.claimed,
    ...facts.handoffs.stillOpenOlder,
  ]) {
    sources.add(handoff.id);
    sources.add(handoff.path);
  }
  for (const question of facts.handoffs.openQuestions) {
    sources.add(question.handoffId);
    sources.add(question.path);
  }
  return sources;
}

function failed(
  error: "llm_error" | "malformed_output",
  redactionCount: number,
): ChronicleNarrationResult {
  return {
    status: "failed",
    narrative: null,
    model: null,
    usage: null,
    error,
    redactionCount,
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function redactValue(value: unknown): { value: unknown; count: number } {
  if (typeof value === "string") {
    const result = redactSecrets(value);
    return { value: result.redacted, count: result.count };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let count = 0;
    for (const item of value) {
      const result = redactValue(item);
      output.push(result.value);
      count += result.count;
    }
    return { value: output, count };
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      const result = redactValue(item);
      output[key] = result.value;
      count += result.count;
    }
    return { value: output, count };
  }
  return { value, count: 0 };
}
