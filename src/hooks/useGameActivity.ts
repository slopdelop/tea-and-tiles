import { useCallback, useEffect, useMemo, useState } from "react";
import type { PairSummary } from "../../shared/players";
import { canUseDebugTools } from "../debugAccess";
import {
  acknowledgeActivity,
  observeActivity,
  readActivityState,
  unreadEvents,
  isRequestActivity,
  type ActivityState,
  type ActivityEvent,
  type ActivitySnapshot,
} from "../gameActivity";

interface Model {
  scope: string | null;
  synced: boolean;
  tables: ActivityState;
  queue: ActivityEvent[];
}
export function advanceActivity(
  model: Model,
  pairs: PairSummary[],
  player: string,
  approved: ReadonlySet<string>,
  selected: string | null,
): Model {
  const tables = observeActivity(
    model.tables,
    pairs,
    player,
    approved,
    Date.now(),
  );
  const before = new Set(
    Object.values(model.tables)
      .flatMap(unreadEvents)
      .map((e) => e.id),
  );
  const live = new Set(
    Object.values(tables)
      .flatMap(unreadEvents)
      .map((e) => e.id),
  );
  let queue = model.queue.filter(
    (e) => live.has(e.id) && e.pairId !== selected,
  );
  if (model.synced) {
    for (const pair of pairs) {
      if (pair.id === selected) continue;
      const fresh = unreadEvents(tables[pair.id]).filter(
        (e) => !before.has(e.id),
      );
      if (!fresh.length) continue;
      // Preserve a queued request when ordinary activity arrives at its table.
      // Only queued or fresh events participate: dismissed notices stay dismissed.
      const candidates = [
        ...queue.filter((e) => e.pairId === pair.id),
        ...fresh,
      ];
      candidates.sort(
        (a, b) =>
          Number(isRequestActivity(b)) - Number(isRequestActivity(a)) ||
          b.at - a.at,
      );
      queue = [...queue.filter((e) => e.pairId !== pair.id), candidates[0]];
    }
  }
  queue.sort(
    (a, b) =>
      Number(isRequestActivity(b)) - Number(isRequestActivity(a)) ||
      a.at - b.at,
  );
  const next = { ...model, synced: true, tables, queue };
  return JSON.stringify(model) === JSON.stringify(next) ? model : next;
}
export function useGameActivity(input: {
  scope: string | null;
  playerId: string | null;
  pairs: PairSummary[];
  serverReady: boolean;
  dictionaryReady: boolean;
  approvedWords: string[];
  selectedPairId: string | null;
}) {
  const {
    scope,
    playerId,
    pairs,
    serverReady,
    dictionaryReady,
    approvedWords,
    selectedPairId,
  } = input;
  const [model, setModel] = useState<Model>({
    scope: null,
    synced: false,
    tables: {},
    queue: [],
  });
  const [preview, setPreview] = useState<{
    model: Model;
    pairs: PairSummary[];
  } | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  const approved = useMemo(
    () => new Set(approvedWords),
    [approvedWords.join("|")],
  );
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    let tables: ActivityState = {};
    if (scope)
      try {
        tables = readActivityState(
          localStorage.getItem(`tea-game-activity:v1:${scope}`),
        );
      } catch {
        /* Optional storage. */
      }
    setModel({ scope, synced: false, tables, queue: [] });
    setPreview(null);
  }, [scope]);
  useEffect(() => {
    if (!scope || !playerId || !serverReady || !dictionaryReady) return;
    setModel((old) =>
      old.scope === scope
        ? advanceActivity(old, pairs, playerId, approved, selectedPairId)
        : old,
    );
  }, [
    scope,
    playerId,
    pairs,
    serverReady,
    dictionaryReady,
    approved,
    selectedPairId,
  ]);
  useEffect(() => {
    if (!scope || model.scope !== scope || !model.synced) return;
    try {
      localStorage.setItem(
        `tea-game-activity:v1:${scope}`,
        JSON.stringify({ version: 1, tables: model.tables }),
      );
    } catch {
      /* In-memory indicators remain usable. */
    }
  }, [scope, model]);
  const acknowledge = useCallback(
    (
      pairId: string,
      delivered: Pick<ActivitySnapshot, "gameId" | "revision" | "actions">,
    ) => {
      if (!scope || document.hidden) return;
      const apply = (old: Model): Model => {
        if (old.scope !== scope) return old;
        const tables = acknowledgeActivity(old.tables, pairId, delivered);
        const ids = new Set(unreadEvents(tables[pairId]).map((e) => e.id));
        const queue = old.queue.filter(
          (e) => e.pairId !== pairId || ids.has(e.id),
        );
        return tables === old.tables && queue.length === old.queue.length
          ? old
          : { ...old, tables, queue };
      };
      setModel(apply);
      setPreview((old) => {
        if (old?.model.scope !== scope) return old;
        const snapshot = old.model.tables[pairId]?.observed;
        const tables = snapshot
          ? acknowledgeActivity(old.model.tables, pairId, snapshot)
          : old.model.tables;
        const next =
          tables === old.model.tables
            ? old.model
            : {
                ...old.model,
                tables,
                queue: old.model.queue.filter((e) => e.pairId !== pairId),
              };
        return next === old.model ? old : { ...old, model: next };
      });
    },
    [scope],
  );
  const dismiss = useCallback(
    (id: string) => {
      setModel((old) =>
        old.scope === scope
          ? { ...old, queue: old.queue.filter((e) => e.id !== id) }
          : old,
      );
      setPreview((old) =>
        old?.model.scope === scope
          ? {
              ...old,
              model: {
                ...old.model,
                queue: old.model.queue.filter((e) => e.id !== id),
              },
            }
          : old,
      );
    },
    [scope],
  );
  const showPreview = useCallback(
    (kind: "turn" | "request" | "two") => {
      if (!canUseDebugTools(playerId) || !scope || !playerId) return;
      const targets = pairs
        .filter((p) => p.id !== selectedPairId)
        .slice(0, kind === "two" ? 2 : 1);
      if (!targets.length) return;
      const baseline = observeActivity(
        {},
        pairs,
        playerId,
        approved,
        Date.now(),
      );
      const changed = pairs.map((p) => {
        const index = targets.findIndex((t) => t.id === p.id);
        if (index < 0) return p;
        if (kind === "request" || (kind === "two" && index === 1))
          return {
            ...p,
            pendingNewGameRequestId: "local-activity-request",
            actionNeededBy: { ...p.actionNeededBy, newGame: playerId },
            actionVersions: {
              ...p.actionVersions,
              newGame: `local-${Date.now()}`,
            },
          };
        const player = p.seatPlayers.mom === playerId ? "aunt" : "mom";
        return {
          ...p,
          activeGame: {
            id: p.activeGameId,
            status: "active" as const,
            turn: player === "mom" ? ("aunt" as const) : ("mom" as const),
            scores: p.activeGame?.scores || { mom: 0, aunt: 0 },
            revision: (p.activeGame?.revision ?? -1) + 1,
            updatedAt: Date.now(),
            lastMove: {
              id: `local-${Date.now()}`,
              player: player as "mom" | "aunt",
              kind: "play" as const,
              at: Date.now(),
            },
          },
        };
      });
      setPreview({
        pairs: changed,
        model: advanceActivity(
          { scope, synced: true, tables: baseline, queue: [] },
          changed,
          playerId,
          approved,
          selectedPairId,
        ),
      });
    },
    [scope, playerId, pairs, selectedPairId, approved],
  );
  const active: Pick<Model, "tables" | "queue"> =
    preview?.model.scope === scope
      ? preview.model
      : model.scope === scope
        ? model
        : { tables: {}, queue: [] };
  const displayedPairs = preview?.model.scope === scope ? preview.pairs : pairs;
  const notice = active.queue.find((e) => e.pairId !== selectedPairId) || null;
  return {
    tables: active.tables,
    notice,
    visible,
    pairs: displayedPairs,
    approved,
    acknowledge,
    dismiss,
    showPreview,
    clearPreview: useCallback(() => setPreview(null), []),
    previewing: !!preview && preview.model.scope === scope,
  };
}
