// The complete primer for a given addendum, for the Settings → Primer live preview (spec 083).
// Mirrors core's composePrimer, which the client can't import (core pulls in node:crypto);
// tests/compose-primer.test.ts pins the two together byte for byte.
export function composePrimer(defaultPrimer: string, addendum: string): string {
  const extra = addendum.trim();
  return extra ? `${defaultPrimer.trimEnd()}\n\n${extra}\n` : defaultPrimer;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
