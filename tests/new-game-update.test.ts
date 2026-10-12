import { describe, expect, it, vi } from "vitest";
import { applyNewGameUpdate } from "../src/hooks/newGameUpdate";

describe("safe new-game updates", () => {
  it("checks and applies a waiting update at an idle game boundary", async () => {
    const check = vi.fn(async () => true);
    const apply = vi.fn(async () => true);
    expect(await applyNewGameUpdate(() => true, check, apply)).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("does not check when a move or request is already in progress", async () => {
    const check = vi.fn(async () => true);
    const apply = vi.fn(async () => true);
    expect(await applyNewGameUpdate(() => false, check, apply)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not reload if a draft starts while an update downloads", async () => {
    let safe = true;
    const check = vi.fn(async () => {
      safe = false;
      return true;
    });
    const apply = vi.fn(async () => true);
    expect(await applyNewGameUpdate(() => safe, check, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not reload when there is no waiting worker", async () => {
    const apply = vi.fn(async () => true);
    expect(
      await applyNewGameUpdate(
        () => true,
        async () => false,
        apply,
      ),
    ).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports an apply failure without claiming an update occurred", async () => {
    expect(
      await applyNewGameUpdate(
        () => true,
        async () => true,
        async () => false,
      ),
    ).toBe(false);
  });
});
