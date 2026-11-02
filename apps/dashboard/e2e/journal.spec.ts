import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Journal page (spec 077 PR D, SC9): read the journal, search it with the agents'
// engine, and permanently delete an entry. The journal has no write API (entries come
// from captured conversations), so the test writes a day file straight into the e2e
// server's vault and switches the journal on through tRPC.

const TRPC_URL = process.env.LIBRARIAN_E2E_TRPC_URL ?? "http://127.0.0.1:3840";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

async function mutate(procedure: string, input: unknown): Promise<void> {
  const res = await fetch(`${TRPC_URL}/trpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${procedure} failed: ${res.status} ${await res.text()}`);
}

function today(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0"))
    .join("-");
}

test.describe("journal page", () => {
  const stamp = Date.now();
  const keep = `Kept entry ${stamp}: chose the quiet timeline.`;
  const drop = `Dropped entry ${stamp}: zebrafish deployment notes.`;

  test.beforeAll(async () => {
    const dataDir = process.env.LIBRARIAN_E2E_DATA_DIR;
    if (!dataDir) throw new Error("LIBRARIAN_E2E_DATA_DIR is unset");
    const date = today();
    const dir = path.join(dataDir, "vault", "journal", "days");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${date}.md`),
      [
        `# ${date}`,
        "",
        "## 09:00–10:00 · claude · e2e-project",
        `<!-- episode: keep-${stamp}#s1 -->`,
        `- ${keep}`,
        "",
        "## 11:00 · codex · e2e-project",
        `<!-- episode: drop-${stamp}#s1 -->`,
        `- ${drop}`,
        "",
      ].join("\n"),
    );
    await mutate("intake.setConfig", { enabled: true });
    await mutate("journal.setConfig", { enabled: true });
  });

  test("reads, searches, and permanently deletes an entry", async ({ page }) => {
    await page.goto("/journal");
    await expect(page.getByRole("heading", { name: "Journal", level: 1 })).toBeVisible();
    await expect(page.getByText(keep)).toBeVisible();
    await expect(page.getByRole("slider", { name: "Journal timeline" }).first()).toBeVisible();

    await page.getByRole("searchbox").fill("zebrafish");
    await expect(page.getByText(/1 best match/)).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();

    await page.getByRole("button", { name: /Delete the 11:00 entry/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Delete the 11:00 entry on");
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText(drop)).toHaveCount(0);
    await expect(page.getByText(keep)).toBeVisible();
  });
});
