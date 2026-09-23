import { expect, test } from "@playwright/test";

// C5b + Chronicle: the unified curator dashboard — ONE page, THREE parallel sections
// (Intake + Grooming + Chronicle), each with enablement, model config, recent runs,
// and run-now. This
// exercises the UI + the round-trip through the same-origin tRPC proxy and the
// real mcp-server intake/curator routers (auth is off in the shared e2e server,
// so this covers the controls + wiring, not the login gate — see global-setup.ts).
//
// Run-now bypasses the enable gate (spec 045 D-4), so it no longer returns
// "disabled" — it runs the job (an empty sweep, or a skip like "incomplete_config"
// when no LLM is configured, or an error). The load-bearing behaviour the run-now
// tests assert is that the result is SURFACED to the admin (Ran / Skipped / Error),
// never swallowed — the specific skip-reason copy is unit-tested (plan 046 T11).

test.describe("unified curator dashboard", () => {
  test("Intake, Grooming, and Chronicle are present with their controls", async ({ page }) => {
    await page.goto("/settings/curator");
    await expect(page.getByRole("heading", { name: "Curator", level: 1 })).toBeVisible();

    // Intake is the default tab on the rc.18 Tabs IA — its controls are
    // visible immediately. Grooming needs an explicit tab click. The tab
    // itself IS the section divider now; there's no redundant h2 inside.
    const intake = page.getByRole("region", { name: "Intake", exact: true });
    await expect(intake.getByRole("button", { name: "Run intake now" })).toBeVisible();
    await expect(intake.getByRole("region", { name: "Intake run history" })).toBeVisible();

    await page.getByRole("tab", { name: "Grooming" }).click();
    const grooming = page.getByRole("region", { name: "Grooming", exact: true });
    await expect(grooming.getByRole("button", { name: "Run grooming now" })).toBeVisible();
    await expect(grooming.getByRole("region", { name: "Grooming run history" })).toBeVisible();

    await page.getByRole("tab", { name: "Chronicle" }).click();
    const chronicle = page.getByRole("region", { name: "Chronicle", exact: true });
    await expect(chronicle.getByRole("button", { name: "Run Chronicle now" })).toBeVisible();
    await expect(chronicle.getByRole("region", { name: "Chronicle run history" })).toBeVisible();

    // Shared provider management lives once, outside the per-job sections.
    await expect(page.getByRole("region", { name: "LLM providers" })).toBeVisible();
  });

  test("intake enablement toggles and persists", async ({ page }) => {
    await page.goto("/settings/curator");
    const intake = page.getByRole("region", { name: "Intake", exact: true });
    const form = intake.getByRole("form", { name: "Intake configuration form" });
    const toggle = form.getByRole("checkbox");

    // Read the current state, flip it, save, and confirm it persisted on reload.
    const before = await toggle.isChecked();
    await toggle.setChecked(!before);
    await form.getByRole("button", { name: /Save settings/i }).click();
    await expect(form.getByText("Saved.")).toBeVisible();

    await page.reload();
    const intakeAfter = page.getByRole("region", { name: "Intake", exact: true });
    const toggleAfter = intakeAfter
      .getByRole("form", { name: "Intake configuration form" })
      .getByRole("checkbox");
    await expect(toggleAfter).toBeChecked({ checked: !before });

    // Restore the original state so the shared e2e store isn't left mutated.
    await toggleAfter.setChecked(before);
    await intakeAfter
      .getByRole("form", { name: "Intake configuration form" })
      .getByRole("button", {
        name: /Save settings/i,
      })
      .click();
    await expect(
      intakeAfter.getByRole("form", { name: "Intake configuration form" }).getByText("Saved."),
    ).toBeVisible();
  });

  test("intake run-now reports a result (surfaced, never swallowed)", async ({ page }) => {
    await page.goto("/settings/curator");
    const intake = page.getByRole("region", { name: "Intake", exact: true });

    // Run-now bypasses the enable gate (spec 045 D-4) — so a disabled intake job
    // still RUNS rather than reporting "disabled". Whatever the outcome (an empty
    // sweep, a skip when no model is configured, or an error), the result is shown,
    // never swallowed. The specific skip-reason copy is unit-tested (plan 046 T11).
    await intake.getByRole("button", { name: "Run intake now" }).click();
    await expect(intake.getByText(/Ran — |Skipped — |Error: /)).toBeVisible();
  });

  test("grooming run-now is operable and reports a result", async ({ page }) => {
    await page.goto("/settings/curator");
    // Grooming is the second tab on the rc.17 Tabs IA — activate it first.
    await page.getByRole("tab", { name: "Grooming" }).click();
    const grooming = page.getByRole("region", { name: "Grooming", exact: true });
    await grooming.getByRole("button", { name: "Run grooming now" }).click();
    // With no provider configured the tick skips; either way the result is shown.
    await expect(grooming.getByText(/Ran — |Skipped — |Error: /)).toBeVisible();
  });

  test("Chronicle schedule persists and Run now writes a partial digest", async ({ page }) => {
    await page.goto("/settings/curator");
    await page.getByRole("tab", { name: "Chronicle" }).click();
    const chronicle = page.getByRole("region", { name: "Chronicle", exact: true });
    const form = chronicle.getByRole("form", { name: "Chronicle schedule" });
    const enabled = form.getByRole("checkbox", { name: /enable scheduled chronicle/i });
    const initialEnabled = await enabled.isChecked();
    const initialDay = await form.getByLabel("Weekday").inputValue();
    const initialTime = await form.getByLabel("Time").inputValue();

    await enabled.setChecked(true);
    await form.getByLabel("Weekday").selectOption("friday");
    await form.getByLabel("Time").fill("17:30");
    await form.getByRole("button", { name: "Save schedule" }).click();
    await expect(form.getByRole("status")).toHaveText("Saved.");

    await page.reload();
    await page.getByRole("tab", { name: "Chronicle" }).click();
    const reloaded = page.getByRole("region", { name: "Chronicle", exact: true });
    const reloadedForm = reloaded.getByRole("form", { name: "Chronicle schedule" });
    await expect(reloadedForm.getByRole("checkbox")).toBeChecked();
    await expect(reloadedForm.getByLabel("Weekday")).toHaveValue("friday");
    await expect(reloadedForm.getByLabel("Time")).toHaveValue("17:30");

    await reloaded.getByRole("button", { name: "Run Chronicle now" }).click();
    await expect(reloaded.getByText(/Ran — .* shelves written/)).toBeVisible();
    const table = reloaded.getByRole("table", { name: "Chronicle runs" });
    await expect(table).toBeVisible();
    await expect(table.getByText("partial", { exact: true }).first()).toBeVisible();
    const pathCell = table.getByText(/references\/chronicle\//).first();
    await expect(pathCell).toBeVisible();
    const chroniclePath = (await pathCell.textContent())?.trim();
    if (!chroniclePath) throw new Error("Chronicle run history did not expose an output path");
    expect(chroniclePath).toMatch(/^references\/chronicle\/\d{4}-W\d{2}\.md$/);

    // Restore the shared suite's config after proving persistence.
    await reloadedForm.getByRole("checkbox").setChecked(initialEnabled);
    await reloadedForm.getByLabel("Weekday").selectOption(initialDay);
    await reloadedForm.getByLabel("Time").fill(initialTime);
    await reloadedForm.getByRole("button", { name: "Save schedule" }).click();
    await expect(reloadedForm.getByRole("status")).toHaveText("Saved.");

    // The run's durable output is visible in the real Vault explorer, not only
    // reported optimistically in Chronicle's sidecar-backed history.
    await page.goto("/");
    await page.getByLabel("Filter vault by path").fill(chroniclePath);
    const vaultTree = page.getByRole("navigation", { name: "Vault tree" });
    const entry = vaultTree.getByRole("link", { name: /\d{4}-W\d{2}\.md/ });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.getByRole("heading", { level: 2, name: chroniclePath })).toBeVisible();
  });

  test("Chronicle controls stay usable from phone to desktop and tabs work by keyboard", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/curator");
      const intakeTab = page.getByRole("tab", { name: "Intake" });
      await intakeTab.focus();
      await intakeTab.press("ArrowRight");
      const groomingTab = page.getByRole("tab", { name: "Grooming" });
      await expect(groomingTab).toHaveAttribute("data-state", "active");
      await groomingTab.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Chronicle" })).toHaveAttribute(
        "data-state",
        "active",
      );
      const chronicle = page.getByRole("region", { name: "Chronicle", exact: true });
      await expect(chronicle.getByRole("form", { name: "Chronicle schedule" })).toBeVisible();
      await expect(chronicle.getByRole("button", { name: "Run Chronicle now" })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    expect(consoleErrors).toEqual([]);
  });
});
