// Drift guard: the Pi proxies' schemas + descriptions are hand-mirrored from
// `@librarian/mcp-server` (Pi tools are typebox, the server's are plain JSON
// Schema, so they can't share one object). This suite compares the two
// mechanically so any server-side change to a verb's teaching surface or input
// shape fails here until the mirror is re-synced.
//
// Differences pinned as intentional:
//   - `agent_id` is server-resolved from the bearer token → never exposed.
//   - `conv_id` (retired domain routing) → never exposed.
//   - server `["<type>","null"]` unions surface as optional `<type>` (omission
//     ≙ null for those filters, and plain types survive every provider's
//     schema translation).

import { tools as serverTools } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { LIBRARIAN_TOOL_NAMES, librarianToolSpecs } from "../extensions/librarian/tools.js";

/** Server-side fields the proxy intentionally hides. */
const HIDDEN_FIELDS = new Set(["agent_id", "conv_id"]);

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, { type?: string | string[]; description?: string }>;
  required?: string[];
}

const serverByName = new Map(serverTools.map((tool) => [tool.name, tool]));

describe("schema parity with @librarian/mcp-server (drift guard)", () => {
  it("every proxied verb exists on the server", () => {
    for (const name of LIBRARIAN_TOOL_NAMES) {
      expect(serverByName.has(name), `server is missing tool '${name}'`).toBe(true);
    }
  });

  for (const spec of librarianToolSpecs()) {
    describe(spec.name, () => {
      it("carries the server's description verbatim (the teaching surface)", () => {
        const server = serverByName.get(spec.name);
        expect(server, `server tool '${spec.name}' not found`).toBeDefined();
        expect(spec.description).toBe(server!.description);
      });

      it("exposes exactly the server's input fields (minus agent_id / conv_id)", () => {
        const server = serverByName.get(spec.name)!;
        const serverSchema = server.inputSchema as JsonSchemaObject;
        const piSchema = spec.parameters as unknown as JsonSchemaObject;

        const serverProps = Object.keys(serverSchema.properties ?? {})
          .filter((key) => !HIDDEN_FIELDS.has(key))
          .sort();
        const piProps = Object.keys(piSchema.properties ?? {}).sort();
        expect(piProps).toEqual(serverProps);
      });

      it("requires exactly what the server requires (minus agent_id)", () => {
        const server = serverByName.get(spec.name)!;
        const serverSchema = server.inputSchema as JsonSchemaObject;
        const piSchema = spec.parameters as unknown as JsonSchemaObject;

        const serverRequired = (serverSchema.required ?? [])
          .filter((key) => !HIDDEN_FIELDS.has(key))
          .sort();
        const piRequired = [...(piSchema.required ?? [])].sort();
        expect(piRequired).toEqual(serverRequired);
      });

      it("each field's type is compatible with the server's", () => {
        const server = serverByName.get(spec.name)!;
        const serverSchema = server.inputSchema as JsonSchemaObject;
        const piSchema = spec.parameters as unknown as JsonSchemaObject;

        for (const [key, piProp] of Object.entries(piSchema.properties ?? {})) {
          const serverProp = serverSchema.properties?.[key];
          expect(serverProp, `server '${spec.name}' lacks property '${key}'`).toBeDefined();
          const serverType = serverProp!.type;
          const piType = piProp.type;
          if (typeof piType !== "string") continue; // enums etc. — names already pinned
          const allowed = Array.isArray(serverType) ? serverType : [serverType];
          expect(
            allowed.includes(piType),
            `'${spec.name}.${key}': pi type '${piType}' not in server type ${JSON.stringify(serverType)}`,
          ).toBe(true);
        }
      });
    });
  }

  it("mirrors the flag_memory.reason field guidance verbatim", () => {
    const serverSchema = serverByName.get("flag_memory")!.inputSchema as JsonSchemaObject;
    const piSchema = librarianToolSpecs().find((tool) => tool.name === "flag_memory")!
      .parameters as unknown as JsonSchemaObject;
    expect(piSchema.properties?.reason?.description).toBe(
      serverSchema.properties?.reason?.description,
    );
  });
});
