// LLM provider + per-consumer model config admin tRPC (spec 042 §4).
//
// The admin cockpit's typed surface for named LLM providers and the per-consumer
// (intake / grooming / chat) provider+model selection. All admin-gated — there is
// no consumer-agent surface for LLM config. Provider tokens are write-only: reads
// expose presence only (`hasToken`), never the value; core's `addProvider` /
// `updateProvider` store the token encrypted.
//
// The model picker (`listModels`) + non-blocking "test connection" call out to
// the provider's `${endpoint}/models`. Both are fail-soft (never throw) and the
// bearer token travels solely in the Authorization header — never in a URL, log,
// or returned error string (`redirect: "error"` so a 3xx can't leak it
// cross-origin; an AbortController timeout so a hung endpoint can't block).

import type {
  ConsumerConfigPatch,
  LibrarianStore,
  LlmProviderInput,
  LlmProviderPatch,
} from "@librarian/core";
import {
  LlmProviderInputSchema,
  LlmProviderPatchSchema,
  addProvider,
  deleteProvider,
  getProvider,
  listProviders,
  readConsumerConfig,
  resolveProviderToken,
  updateProvider,
  writeConsumerConfig,
} from "@librarian/core";
import { z } from "zod";
import { fetchProviderModels, probeProviderConnection } from "./llm-models.js";
import { adminProcedure, router } from "./trpc.js";

// The per-consumer LLM config surface covers the three curator JOBS (intake /
// grooming / chronicle) PLUS the config-only `chat` consumer (spec 044 D-8) — D6b's curator
// chat endpoint's LLM, which falls back to the grooming consumer when its own
// config is unset (handled in core's readConsumerConfig / resolveConsumerToken).
// `chat` has no enablement, so a `setConsumerConfig({consumer:"chat", enabled})`
// is rejected at the core boundary.
const ConsumerSchema = z.enum(["intake", "grooming", "chronicle", "chat"]);

// A model query may target an already-saved provider (token resolved from the
// vault) OR an inline draft `{ endpoint, token }`, so the dashboard can test a
// provider before saving it. `providerId` wins when both are supplied.
const ProbeSchema = z.strictObject({
  providerId: z.string().optional(),
  endpoint: z.string().optional(),
  token: z.string().optional(),
});

// Reuse core's patch schema (single source of truth) + the target id.
const UpdateProviderSchema = LlmProviderPatchSchema.extend({ id: z.string().min(1) });

const SetConsumerSchema = z.strictObject({
  consumer: ConsumerSchema,
  // Unified job enablement (curator.<consumer>.enabled, spec 043 D-E). The
  // dashboard (C5) toggles intake/grooming through here; the setting is
  // authoritative over the legacy env/setting.
  enabled: z.boolean().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().optional(),
  // Output cap per call (thinking included) and the optional thinking level; ""/null
  // clears the thinking level. Bounds are enforced in core's writeConsumerConfig.
  maxOutputTokens: z.number().optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high", ""]).nullable().optional(),
});

export const llmRouter = router({
  // Named providers — list/get never include the token, only `hasToken`.
  listProviders: adminProcedure.query(({ ctx }) => listProviders(ctx.store)),

  addProvider: adminProcedure
    .input(LlmProviderInputSchema)
    // Cast at the validated boundary: Zod `.optional()` infers `T | undefined`,
    // which the input type (optional-key, not undefined-value) rejects under
    // exactOptionalPropertyTypes. The schema already validated the shape.
    .mutation(({ ctx, input }) => addProvider(ctx.store, input as LlmProviderInput)),

  updateProvider: adminProcedure.input(UpdateProviderSchema).mutation(({ ctx, input }) => {
    const { id, ...patch } = input;
    updateProvider(ctx.store, id, patch as LlmProviderPatch);
    return getProvider(ctx.store, id);
  }),

  deleteProvider: adminProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      deleteProvider(ctx.store, input.id);
      return listProviders(ctx.store);
    }),

  // Per-consumer provider+model selection (intake / grooming / chronicle / chat). Reading
  // the `chat` consumer returns its grooming-fallback-resolved view when chat's
  // own config is unset (spec 044 D-8).
  consumerConfig: adminProcedure
    .input(z.strictObject({ consumer: ConsumerSchema }))
    .query(({ ctx, input }) => readConsumerConfig(ctx.store, input.consumer)),

  setConsumerConfig: adminProcedure.input(SetConsumerSchema).mutation(({ ctx, input }) => {
    const { consumer, ...patch } = input;
    writeConsumerConfig(ctx.store, consumer, patch as ConsumerConfigPatch);
    return readConsumerConfig(ctx.store, consumer);
  }),

  // Populate the model picker. Fail-soft: any error (unreachable endpoint, auth
  // failure, malformed body) yields `[]` so the UI falls back to free-text entry.
  listModels: adminProcedure.input(ProbeSchema).query(async ({ ctx, input }) => {
    const target = resolveProbeTarget(ctx.store, input);
    if (!target) return { models: [] };
    return { models: await fetchProviderModels(target.endpoint, target.token) };
  }),

  // Non-blocking "test connection". Never throws; returns a plain ok/error result
  // whose `error` string is built only from status/transport detail — never the token.
  testConnection: adminProcedure.input(ProbeSchema).query(async ({ ctx, input }) => {
    const target = resolveProbeTarget(ctx.store, input);
    if (!target) return { ok: false, error: "no endpoint configured" };
    return probeProviderConnection(target.endpoint, target.token);
  }),
});

interface ProbeTarget {
  endpoint: string;
  token: string;
}

// Resolve the `{ endpoint, token }` to probe. A `providerId` reads the saved
// endpoint + decrypts the stored token (the inline draft is ignored); otherwise
// the inline draft is used. Returns null when no usable endpoint is available.
function resolveProbeTarget(
  store: LibrarianStore,
  input: z.infer<typeof ProbeSchema>,
): ProbeTarget | null {
  if (input.providerId) {
    const provider = getProvider(store, input.providerId);
    if (!provider?.endpoint) return null;
    // Decrypting the token needs the master key; if it's absent the read throws.
    // Probe the endpoint token-less rather than throwing out of a fail-soft query.
    let token = "";
    try {
      token = resolveProviderToken(store, input.providerId) ?? "";
    } catch {
      token = "";
    }
    return { endpoint: provider.endpoint, token };
  }
  const endpoint = (input.endpoint ?? "").trim();
  if (!endpoint) return null;
  return { endpoint, token: input.token ?? "" };
}
