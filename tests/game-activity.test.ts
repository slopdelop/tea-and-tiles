import { describe, expect, it } from "vitest";
import type { PairSummary } from "../shared/players";
import {
  acknowledgeActivity,
  activitySnapshot,
  incomingActions,
  observeActivity,
  readActivityState,
  unreadEvents,
} from "../src/gameActivity";
const approved = new Set<string>();
function pair(id = "one", opposite = false): PairSummary {
  return {
    id,
    schemaVersion: 2,
    memberIds: ["justin", "mabel"],
    seatPlayers: opposite
      ? { mom: "mabel", aunt: "justin" }
      : { mom: "justin", aunt: "mabel" },
    names: { mom: "Justin", aunt: "Mabel" },
    activeGameId: `game-${id}`,
    activeGame: {
      id: `game-${id}`,
      status: "active",
      turn: "mom",
      scores: { mom: 0, aunt: 0 },
      revision: 0,
      updatedAt: 1,
      lastMove: null,
    },
  };
}
function moved(
  p: PairSummary,
  player: "mom" | "aunt" = "aunt",
  id = "move-1",
): PairSummary {
  return {
    ...p,
    activeGame: {
      ...p.activeGame!,
      revision: p.activeGame!.revision + 1,
      lastMove: { id, player, kind: "pass", at: 10 },
    },
  };
}
const observe = (
  state: Parameters<typeof observeActivity>[0],
  pairs: PairSummary[],
) => observeActivity(state, pairs, "justin", approved, 20);
describe("other-table activity", () => {
  it("baselines first-seen tables without historical notifications", () => {
    const p = moved(pair());
    expect(unreadEvents(observe({}, [p]).one)).toEqual([]);
  });
  it("deduplicates snapshots and callable retries", () => {
    const p = pair(),
      q = moved(p);
    const state = observe(observe({}, [p]), [q]);
    expect(unreadEvents(state.one)).toHaveLength(1);
    expect(observe(state, [q])).toEqual(state);
  });
  it("resolves actors independently in opposite seats and ignores own-device moves", () => {
    const p = pair("one", true);
    const state = observe({}, [p]);
    expect(unreadEvents(observe(state, [moved(p, "aunt")]).one)).toHaveLength(
      0,
    );
    expect(unreadEvents(observe(state, [moved(p, "mom")]).one)).toHaveLength(1);
  });
  it("acknowledges only delivered revisions and keeps newer turns unread", () => {
    const p = pair(),
      q = moved(p);
    const state = observe(observe({}, [p]), [q]);
    expect(
      acknowledgeActivity(state, "one", {
        gameId: p.activeGameId,
        revision: 0,
        actions: {},
      }),
    ).toEqual(state);
    const seen = acknowledgeActivity(state, "one", {
      gameId: p.activeGameId,
      revision: 1,
      actions: {},
    });
    expect(unreadEvents(seen.one)).toHaveLength(0);
    expect(unreadEvents(observe(seen, [q]).one)).toHaveLength(0);
  });
  it("keeps request action after unread is cleared, and re-asks have new identities", () => {
    const p = pair();
    const q = {
      ...p,
      actionNeededBy: { newGame: "justin" },
      actionVersions: { newGame: "request-1" },
    };
    const s = observe(observe({}, [p]), [q]);
    const seen = acknowledgeActivity(
      s,
      "one",
      activitySnapshot(q, "justin", approved),
    );
    expect(unreadEvents(seen.one)).toHaveLength(0);
    expect(incomingActions(q, "justin", approved)).toEqual({
      newGame: "request-1",
    });
    const asked = { ...q, actionVersions: { newGame: "request-2" } };
    expect(unreadEvents(observe(seen, [asked]).one)).toHaveLength(1);
  });
  it("versions reused word requests and suppresses globally approved words", () => {
    const p = pair(),
      q = {
        ...p,
        actionNeededBy: { "word-aunt-ZZ": "justin" },
        actionVersions: { "word-aunt-ZZ": "game-one:1" },
      };
    const s = observe(observe({}, [p]), [q]);
    expect(unreadEvents(s.one)).toHaveLength(1);
    const next = observeActivity(s, [q], "justin", new Set(["ZZ"]), 30);
    expect(unreadEvents(next.one)).toHaveLength(0);
  });
  it("clearing a request preserves an unread move underneath", () => {
    const p = pair(),
      q = {
        ...moved(p),
        actionNeededBy: { newGame: "justin" },
        actionVersions: { newGame: "r" },
      };
    const s = observe(observe({}, [p]), [q]);
    expect(unreadEvents(s.one)).toHaveLength(2);
    expect(
      unreadEvents(observe(s, [{ ...q, actionNeededBy: {} }]).one),
    ).toHaveLength(1);
  });
  it("new rounds reset old activity and acknowledgments cannot cross games", () => {
    const p = pair(),
      s = observe(observe({}, [p]), [moved(p)]);
    const q = {
      ...p,
      activeGameId: "fresh",
      activeGame: { ...p.activeGame!, id: "fresh" },
    };
    const n = observe(s, [q]);
    expect(unreadEvents(n.one).map((e) => e.kind)).toEqual(["ready"]);
    expect(
      acknowledgeActivity(n, "one", {
        gameId: p.activeGameId,
        revision: 99,
        actions: {},
      }),
    ).toEqual(n);
  });
  it("does not call a timer ending a played turn", () => {
    const p = pair(),
      q = {
        ...p,
        activeGame: {
          ...p.activeGame!,
          revision: 1,
          status: "finished" as const,
        },
      };
    expect(
      unreadEvents(observe(observe({}, [p]), [q]).one).map((e) => e.kind),
    ).toEqual(["finished"]);
  });
  it("prunes removed memberships and rejects malformed persistence", () => {
    const p = pair();
    expect(observe(observe({}, [p]), [])).toEqual({});
    for (const raw of [
      "broken",
      "{}",
      '{"version":1,"tables":{"bad":{"observed":{}}}}',
    ])
      expect(readActivityState(raw)).toEqual({});
  });
  it("persists unread state and tolerates unsupported old summary fields", () => {
    const p = pair(),
      q = moved(p);
    const s = observe(observe({}, [p]), [q]);
    expect(
      readActivityState(JSON.stringify({ version: 1, tables: s })),
    ).toEqual(s);
  });
  it("ignores older revisions", () => {
    const p = pair(),
      q = moved(p);
    const s = observe(observe({}, [p]), [q]);
    expect(observe(s, [p])).toEqual(s);
  });
});
