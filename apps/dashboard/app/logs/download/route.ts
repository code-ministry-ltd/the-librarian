// Download one log in full as NDJSON (spec 081). Behind the dashboard's session gate like every
// other page (middleware.ts), and the export procedure itself is admin-only.

import type { NextRequest } from "next/server";
import { downloadFileName, isLogSourceId, toNdjson } from "@/lib/log-sources";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const source = request.nextUrl.searchParams.get("source");
  if (!isLogSourceId(source)) {
    return new Response(
      "Unknown log. Expected source=reads, refusals, captures, intake, curation, backups or vault.",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  let result;
  try {
    result = await serverTRPC.logs.export.query({ source });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Could not export the ${source} log: ${message}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(toNdjson(result.rows), {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${downloadFileName(source)}"`,
      "cache-control": "no-store",
      ...(result.truncated ? { "x-librarian-truncated": "true" } : {}),
    },
  });
}
