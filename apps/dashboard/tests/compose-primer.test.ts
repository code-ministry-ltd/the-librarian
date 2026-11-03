// The Settings → Primer preview must match what the server sends byte for byte (spec 083). The
// dashboard keeps its own composePrimer because client code can't import core; this pins the two.

import { DEFAULT_PRIMER, composePrimer as coreCompose } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { composePrimer, utf8Bytes } from "@/lib/compose-primer";

describe("composePrimer (dashboard preview)", () => {
  it.each(["", "   ", "Use British English.", "\n\nTwo\n\nparagraphs.\n\n", "é ünïcode"])(
    "matches core for %j",
    (addendum) => {
      expect(composePrimer(DEFAULT_PRIMER, addendum)).toBe(coreCompose(addendum));
    },
  );

  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("é")).toBe(2);
  });
});
