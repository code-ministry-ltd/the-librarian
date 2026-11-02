import { expect, test } from "@playwright/test";

// C5b: the unified curator dashboard — ONE page, TWO parallel sections
// (Intake + Grooming), each with enablement, model config, recent runs,
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
  test("Intake and Grooming are present with their controls, and Chronicle is gone", async ({
    page,
  }) => {
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

    // Chronicle was retired in 1.40.0: the journal replaces it.
    await expect(page.getByRole("tab", { name: "Chronicle" })).toHaveCount(0);

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

  test("curator controls stay usable from phone to desktop and tabs work by keyboard", async ({
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
      const grooming = page.getByRole("region", { name: "Grooming", exact: true });
      await expect(grooming.getByRole("button", { name: "Run grooming now" })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    expect(consoleErrors).toEqual([]);
  });
});
