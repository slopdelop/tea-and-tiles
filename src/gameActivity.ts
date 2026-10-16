import type { PairSummary } from "../shared/players";

export type ActivityKind =
  "turn" | "updated" | "finished" | "ready" | "newGame" | "endGame" | "word";
export interface ActivityEvent {
  id: string;
  pairId: string;
  gameId: string;
  revision: number;
  kind: ActivityKind;
  at: number;
}
export interface ActivitySnapshot {
  gameId: string;
  revision: number;
  moveId: string;
  status: string;
  actions: Record<string, string>;
}
export interface TableActivity {
  observed: ActivitySnapshot;
  move?: ActivityEvent;
  round?: ActivityEvent;
  requests: Record<string, ActivityEvent>;
}
export type ActivityState = Record<string, TableActivity>;
export const isRequestActivity = (event: ActivityEvent) =>
  ["newGame", "endGame", "word"].includes(event.kind);
export function incomingActions(
  pair: PairSummary,
  playerId: string,
  approved: ReadonlySet<string>,
) {
  const actions: Record<string, string> = {};
  for (const [key, recipient] of Object.entries(pair.actionNeededBy || {})) {
    if (recipient !== playerId) continue;
    if (key.startsWith("word-")) {
      if (
        !/^word-(mom|aunt)-[A-Z]{2,15}$/.test(key) ||
        approved.has(key.split("-").slice(2).join("-"))
      )
        continue;
    } else if (key !== "newGame" && key !== "endGame") continue;
    if (key === "endGame" && pair.activeGame?.status === "finished") continue;
    actions[key] =
      pair.actionVersions?.[key] ||
      (key === "newGame"
        ? pair.pendingNewGameRequestId
        : key === "endGame"
          ? pair.pendingEndGameRequestId
          : null) ||
      `legacy:${key}`;
  }
  return actions;
}
export function activitySnapshot(
  pair: PairSummary,
  player: string,
  approved: ReadonlySet<string>,
): ActivitySnapshot {
  return {
    gameId: pair.activeGameId,
    revision: pair.activeGame?.revision ?? -1,
    moveId: pair.activeGame?.lastMove?.id || "",
    status: pair.activeGame?.status || "",
    actions: incomingActions(pair, player, approved),
  };
}
export function unreadEvents(table?: TableActivity): ActivityEvent[] {
  return table
    ? [table.move, table.round, ...Object.values(table.requests)].filter(
        (event): event is ActivityEvent => !!event,
      )
    : [];
}
export function observeActivity(
  previous: ActivityState,
  pairs: PairSummary[],
  player: string,
  approved: ReadonlySet<string>,
  now: number,
): ActivityState {
  const next: ActivityState = {};
  for (const pair of pairs) {
    const observed = activitySnapshot(pair, player, approved);
    const old = previous[pair.id];
    if (!old) {
      next[pair.id] = { observed, requests: {} };
      continue;
    }
    // A stale snapshot must not move our observation or acknowledgment backwards.
    if (
      old.observed.gameId === observed.gameId &&
      observed.revision < old.observed.revision
    ) {
      next[pair.id] = old;
      continue;
    }
    const table: TableActivity = { ...old, observed, requests: {} };
    const event = (kind: ActivityKind, token: string): ActivityEvent => ({
      id: `${pair.id}:${observed.gameId}:${kind}:${token}`,
      pairId: pair.id,
      gameId: observed.gameId,
      revision: observed.revision,
      kind,
      at: now,
    });
    if (old.observed.gameId !== observed.gameId) {
      table.move = undefined;
      table.round = event("ready", observed.gameId);
    } else if (observed.revision > old.observed.revision) {
      if (
        observed.status === "finished" &&
        old.observed.status !== "finished"
      ) {
        table.move = undefined;
        table.round = event("finished", String(observed.revision));
      } else {
        const move = pair.activeGame?.lastMove;
        if (
          move &&
          move.id !== old.observed.moveId &&
          pair.seatPlayers[move.player] !== player
        )
          table.move = event("turn", move.id);
        else if (!move && observed.status === "active")
          table.move = event("updated", String(observed.revision));
      }
    }
    for (const [key, token] of Object.entries(observed.actions)) {
      if (
        old.observed.gameId === observed.gameId &&
        old.requests[key] &&
        old.observed.actions[key] === token
      )
        table.requests[key] = old.requests[key];
      else if (
        old.observed.gameId !== observed.gameId ||
        old.observed.actions[key] !== token
      )
        table.requests[key] = event(
          key === "newGame"
            ? "newGame"
            : key === "endGame"
              ? "endGame"
              : "word",
          `${key}:${token}`,
        );
    }
    next[pair.id] = table;
  }
  return next;
}
export function acknowledgeActivity(
  state: ActivityState,
  pairId: string,
  delivered: Pick<ActivitySnapshot, "gameId" | "revision" | "actions">,
): ActivityState {
  const old = state[pairId];
  if (!old || old.observed.gameId !== delivered.gameId) return state;
  const table = { ...old, requests: { ...old.requests } };
  if (table.move && table.move.revision <= delivered.revision)
    table.move = undefined;
  if (table.round && table.round.revision <= delivered.revision)
    table.round = undefined;
  for (const key of Object.keys(table.requests))
    if (delivered.actions[key] === old.observed.actions[key])
      delete table.requests[key];
  const next = { ...state, [pairId]: table };
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}
export function readActivityState(raw: string | null): ActivityState {
  try {
    const data = JSON.parse(raw || "null");
    if (
      data?.version !== 1 ||
      !data.tables ||
      typeof data.tables !== "object" ||
      Array.isArray(data.tables)
    )
      return {};
    const state: ActivityState = {};
    const validEvent = (event: unknown): event is ActivityEvent => {
      const e = event as ActivityEvent;
      return (
        !!e &&
        typeof e.id === "string" &&
        typeof e.pairId === "string" &&
        typeof e.gameId === "string" &&
        Number.isFinite(e.revision) &&
        Number.isFinite(e.at) &&
        [
          "turn",
          "updated",
          "finished",
          "ready",
          "newGame",
          "endGame",
          "word",
        ].includes(e.kind)
      );
    };
    for (const [id, value] of Object.entries(data.tables).slice(0, 100)) {
      const table = value as TableActivity,
        s = table?.observed;
      if (
        !s ||
        typeof s.gameId !== "string" ||
        !Number.isFinite(s.revision) ||
        typeof s.moveId !== "string" ||
        typeof s.status !== "string" ||
        !s.actions ||
        typeof s.actions !== "object" ||
        Object.values(s.actions).some((v) => typeof v !== "string")
      )
        continue;
      state[id] = {
        observed: s,
        move: validEvent(table.move) ? table.move : undefined,
        round: validEvent(table.round) ? table.round : undefined,
        requests: Object.fromEntries(
          Object.entries(table.requests || {})
            .slice(0, 100)
            .filter(([, e]) => validEvent(e)),
        ),
      };
    }
    return state;
  } catch {
    return {};
  }
}
export function activityText(event: ActivityEvent, opponent: string) {
  return {
    turn: `${opponent} finished their turn.`,
    updated: `There’s new activity in your game with ${opponent}.`,
    finished: `Your game with ${opponent} has ended.`,
    ready: `Your new game with ${opponent} is ready.`,
    newGame: `${opponent} would like to start a new game.`,
    endGame: `${opponent} would like to end your game.`,
    word: `${opponent} would like to add a word.`,
  }[event.kind];
}
