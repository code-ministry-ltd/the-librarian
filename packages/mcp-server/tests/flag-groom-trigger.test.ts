// The targeted flag groom's timer (ADR 0013): wait for 10 quiet minutes after
// the latest flag, but never more than 30 after the first, then run once.

import { describe, expect, it, vi } from "vitest";
import { createFlagGroomTrigger } from "../src/flag-groom-trigger.js";

const MIN = 60_000;

function setup(options: { ran?: boolean; pending?: () => boolean } = {}) {
  let clock = 0;
  const runFlagGroom = vi.fn(async () => ({ ran: options.ran ?? true }));
  const trigger = createFlagGroomTrigger({
    runFlagGroom,
    hasPending: options.pending ?? (() => false),
    now: () => clock,
  });
  return {
    trigger,
    runFlagGroom,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("flag groom trigger", () => {
  it("does nothing until a flag arrives", async () => {
    const { trigger, runFlagGroom } = setup();
    await trigger.tick();
    expect(runFlagGroom).not.toHaveBeenCalled();
  });

  it("runs once, 10 minutes after the latest flag of a burst", async () => {
    const { trigger, runFlagGroom, advance } = setup();
    trigger.noteFlag();
    advance(4 * MIN);
    trigger.noteFlag();
    advance(9 * MIN);
    await trigger.tick();
    expect(runFlagGroom).not.toHaveBeenCalled();

    advance(1 * MIN);
    await trigger.tick();
    await trigger.tick();
    expect(runFlagGroom).toHaveBeenCalledTimes(1);
    expect(trigger.isArmed()).toBe(false);
  });

  it("never waits more than 30 minutes after the first flag, however steady the trickle", async () => {
    const { trigger, runFlagGroom, advance } = setup();
    trigger.noteFlag();
    for (let i = 0; i < 6; i++) {
      advance(5 * MIN);
      trigger.noteFlag();
      await trigger.tick();
    }
    expect(runFlagGroom).toHaveBeenCalledTimes(1); // at 30 minutes
  });

  it("goes again after another quiet period while flags are still waiting", async () => {
    let waiting = true;
    const { trigger, runFlagGroom, advance } = setup({ pending: () => waiting });
    trigger.noteFlag();
    advance(10 * MIN);
    await trigger.tick();
    expect(trigger.isArmed()).toBe(true);

    waiting = false;
    advance(10 * MIN);
    await trigger.tick();
    expect(runFlagGroom).toHaveBeenCalledTimes(2);
    expect(trigger.isArmed()).toBe(false);
  });

  it("does not spin when the groom could not run (grooming off)", async () => {
    const { trigger, runFlagGroom, advance } = setup({ ran: false, pending: () => true });
    trigger.noteFlag();
    advance(10 * MIN);
    await trigger.tick();
    advance(10 * MIN);
    await trigger.tick();
    expect(runFlagGroom).toHaveBeenCalledTimes(1);
    expect(trigger.isArmed()).toBe(false);
  });

  it("survives a failing groom and reports the error", async () => {
    let clock = 0;
    const onError = vi.fn();
    const trigger = createFlagGroomTrigger({
      runFlagGroom: async () => {
        throw new Error("model down");
      },
      hasPending: () => true,
      now: () => clock,
      onError,
    });
    trigger.noteFlag();
    clock += 10 * MIN;
    await expect(trigger.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
