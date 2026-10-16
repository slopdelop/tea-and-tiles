import { useCallback, useEffect, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  describeFirestoreTransport,
  firestoreTransport,
} from "./firestoreTransport";
import { usePlayerPresence } from "./hooks/usePlayerPresence";
import { createTimedGameSync } from "./hooks/timedGameSync";
import { startBrowserDiagnostics } from "./diagnostics/browserDiagnostics";
import type {
  DiagnosticReply,
  MoveDiagnosticReport,
  DiagnosticEventName,
} from "../shared/move-diagnostics";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import {
  sharedActionPause,
  type SharedActionPause,
} from "./sharedAvailability";
import {
  connectAuthEmulator,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import type {
  Command,
  CommandResult,
  Game,
  Slot,
  Tile,
  WinCondition,
} from "../shared/engine";
import type {
  HouseWord,
  WordRequest,
  WordDecision,
} from "../shared/dictionary";
import type {
  NewGameRequest,
  TimedGameResult,
  EndGameRequest,
  EndGameResponse,
} from "../shared/game-request";
export type PublicGame = Omit<Game, "racks" | "bag"> & {
  rackCounts: Record<Slot, number>;
  bagCount: number;
};
import type { PairSummary } from "../shared/players";
export type { PairSummary } from "../shared/players";
const emulator = import.meta.env.VITE_USE_EMULATORS !== "false";
const projectId =
  import.meta.env.VITE_FIREBASE_PROJECT_ID || "demo-tea-and-tiles";
const appCheckSiteKey = import.meta.env.VITE_APP_CHECK_SITE_KEY;
export const configured =
  emulator ||
  (!!import.meta.env.VITE_FIREBASE_API_KEY &&
    !!import.meta.env.VITE_FIREBASE_APP_ID &&
    !!appCheckSiteKey &&
    !projectId.startsWith("demo-"));
const app = initializeApp({
  projectId,
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "demo-key",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "demo-app",
});
// The local emulators need no attestation or cloud verification provider.
// Production has no debug-token or environment-switch bypass.
if (!emulator && configured) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
});
const db = initializeFirestore(app, firestoreTransport(emulator, navigator));
const functions = getFunctions(
  app,
  import.meta.env.VITE_FUNCTIONS_REGION || "europe-west2",
);
if (emulator) {
  const host = import.meta.env.VITE_EMULATOR_HOST || "127.0.0.1";
  const port = (configured: unknown, fallback: number) => {
    const value = configured === undefined ? fallback : Number(configured);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error("An emulator port must be a number between 1 and 65535.");
    return value;
  };
  connectAuthEmulator(
    auth,
    `http://${host}:${port(import.meta.env.VITE_AUTH_EMULATOR_PORT, 9099)}`,
    { disableWarnings: true },
  );
  connectFirestoreEmulator(
    db,
    host,
    port(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT, 8080),
  );
  connectFunctionsEmulator(
    functions,
    host,
    port(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT, 5001),
  );
}
const retryable = (e: unknown) =>
  [
    "functions/unavailable",
    "functions/deadline-exceeded",
    "functions/internal",
    "functions/unknown",
    "functions/cancelled",
  ].includes((e as { code?: string })?.code || "functions/unknown");
const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "Unable to reach the game. Please try again.";
export function useGameSession() {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [pairsReady, setPairsReady] = useState(false);
  const [pairsServerReady, setPairsServerReady] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [defaultPairId, setDefaultPairId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [pairId, setPairId] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const contextRef = useRef("");
  const mutationOperations = useRef(new Set<symbol>());
  const busyOwner = useRef<symbol | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null),
    [names, setNames] = useState<Record<Slot, string>>({
      mom: "Elizabeth",
      aunt: "Rita",
    }),
    [game, setGame] = useState<PublicGame | null>(null),
    [rack, setRack] = useState<Tile[]>([]),
    [houseWords, setHouseWords] = useState<HouseWord[]>([]),
    [wordRequests, setWordRequests] = useState<WordRequest[]>([]),
    [dictionaryReady, setDictionaryReady] = useState(false),
    [wordRequestsReady, setWordRequestsReady] = useState(false),
    [dictionaryError, setDictionaryError] = useState<string | null>(null),
    [newGameRequests, setNewGameRequests] = useState<NewGameRequest[]>([]),
    [newGameRequestsForGame, setNewGameRequestsForGame] = useState<
      string | null
    >(null),
    [newGameRequestsReady, setNewGameRequestsReady] = useState(false),
    [endGameRequests, setEndGameRequests] = useState<EndGameRequest[]>([]),
    [endGameRequestsForGame, setEndGameRequestsForGame] = useState<
      string | null
    >(null),
    [endGameRequestsReady, setEndGameRequestsReady] = useState(false),
    [endGameRequestsError, setEndGameRequestsError] = useState<string | null>(
      null,
    ),
    [newGameRequestsError, setNewGameRequestsError] = useState<string | null>(
      null,
    ),
    [loading, setLoading] = useState(true),
    [connected, setConnected] = useState(navigator.onLine),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState<Command | null>(null),
    [uid, setUid] = useState<string | null>(null);
  const pendingRef = useRef<Command | null>(null),
    busy = useRef(false);
  const confirmedRef = useRef<CommandResult | null>(null);
  const selectedPair = pairs.find((pair) => pair.id === pairId);
  const activeGameId = selectedPair?.activeGameId;
  const selectedSlot: Slot | null =
    selectedPair?.seatPlayers?.mom === playerId
      ? "mom"
      : selectedPair?.seatPlayers?.aunt === playerId
        ? "aunt"
        : null;
  const diagnostics = useRef<ReturnType<typeof startBrowserDiagnostics>>(null);
  useEffect(() => {
    if (!uid || !selectedSlot) return;
    const active = startBrowserDiagnostics(
      `${projectId}:${uid}:${pairId}`,
      async (input) => {
        const reply = await httpsCallable<
          | { action: "clock"; pairId: string | null }
          | {
              action: "report";
              report: MoveDiagnosticReport;
              pairId: string | null;
            },
          DiagnosticReply
        >(functions, "reportMoveDiagnostics", { timeout: 15000 })({
          ...input,
          pairId,
        });
        return reply.data;
      },
      describeFirestoreTransport(firestoreTransport(emulator, navigator)),
    );
    diagnostics.current = active;
    return () => {
      active?.dispose();
      diagnostics.current = null;
    };
  }, [uid, selectedSlot, pairId]);
  const noteMoveDisplayed = useCallback(
    (gameId: string, revision: number) =>
      diagnostics.current?.recorder.displayed(gameId, revision),
    [],
  );
  const noteMovePresentation = useCallback(
    (name: DiagnosticEventName, gameId: string, moveId?: string) =>
      diagnostics.current?.recorder.record(name, { gameId, moveId }),
    [],
  );
  const presenceStatus = usePlayerPresence(
    db,
    uid,
    slot,
    !!game,
    connected,
    game?.startedAt,
    pairId,
  );
  const [sharedPause, setSharedPause] = useState<SharedActionPause | null>(
    null,
  );
  const sharedPauseRef = useRef<SharedActionPause | null>(null);
  const resumeSharedActions = useCallback(() => {
    sharedPauseRef.current = null;
    setSharedPause(null);
  }, []);
  const noteServiceFailure = useCallback((failure: unknown) => {
    const pause = sharedActionPause(failure, Date.now());
    if (pause) {
      sharedPauseRef.current = pause;
      setSharedPause(pause);
    }
    return pause;
  }, []);
  useEffect(() => {
    if (!sharedPause?.resumeAt) return;
    const timer = setTimeout(
      resumeSharedActions,
      Math.max(0, sharedPause.resumeAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [sharedPause, resumeSharedActions]);
  const callShared = useCallback(
    async <Input, Output>(name: string, input: Input): Promise<Output> => {
      const operationContext = contextRef.current;
      const unscoped = name === "loginPlayer" || name === "enrollPlayer";
      if (busy.current && unscoped)
        throw new Error("Please wait for your move to finish.");
      const pause = sharedPauseRef.current;
      if (pause && (!pause.resumeAt || pause.resumeAt > Date.now()))
        throw new Error(pause.message);
      if (pause) resumeSharedActions();
      const operation = Symbol(name);
      mutationOperations.current.add(operation);
      setMutationBusy(true);
      try {
        const result = await httpsCallable<Input, Output>(
          functions,
          name,
        )(
          unscoped
            ? input
            : {
                ...input,
                pairId,
                gameId: (input as { gameId?: string }).gameId || game?.id,
              },
        );
        return result.data;
      } catch (failure) {
        const issue =
          operationContext === contextRef.current
            ? noteServiceFailure(failure)
            : null;
        if (issue) {
          const original = failure as { code?: string; details?: unknown };
          throw Object.assign(new Error(issue.message), {
            code: original.code,
            details: original.details,
          });
        }
        throw failure;
      } finally {
        mutationOperations.current.delete(operation);
        setMutationBusy(mutationOperations.current.size > 0);
      }
    },
    [noteServiceFailure, resumeSharedActions, pairId, game?.id],
  );
  const [timedClock, setTimedClock] = useState<{
    gameId: string;
    offset: number;
  } | null>(null);
  const storageKey = useRef("");
  const savePending = useCallback(
    (command: Command | null, key = storageKey.current) => {
      if (key) {
        if (command) {
          try {
            localStorage.setItem(key, JSON.stringify(command));
          } catch {
            throw new Error(
              "Your iPad could not save this move for recovery. Free some storage and try again.",
            );
          }
        } else {
          try {
            localStorage.removeItem(key);
          } catch {
            /* A stored confirmed command will reconcile again on reload. */
          }
        }
      }
      if (key === storageKey.current) {
        pendingRef.current = command;
        setPending(command);
      }
    },
    [],
  );
  useEffect(() => {
    const online = () => setConnected(navigator.onLine);
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
    };
  }, []);
  useEffect(() => {
    if (!configured) {
      setLoading(false);
      setError(
        "The game needs its Firebase web configuration and App Check site key.",
      );
      return;
    }
    return onAuthStateChanged(auth, async (user) => {
      contextRef.current = "auth-changing";
      busy.current = false;
      busyOwner.current = null;
      mutationOperations.current.clear();
      setMutationBusy(false);
      resumeSharedActions();
      // Clear private account state before replacing an anonymous session.
      setUid(null);
      setPlayerId(null);
      setSlot(null);
      setPairId(null);
      setPairs([]);
      setGame(null);
      setRack([]);
      setDisplayName("");
      setDefaultPairId(null);
      storageKey.current = "";
      pendingRef.current = null;
      setPending(null);
      if (!user) {
        try {
          await signInAnonymously(auth);
        } catch (e) {
          setError(message(e));
          setLoading(false);
        }
        return;
      }
      setUid(user.uid);
    });
  }, [savePending, resumeSharedActions]);
  useEffect(() => {
    if (!uid) return;
    let disposed = false;
    const stop = onSnapshot(
      doc(db, "bindings", uid),
      (snapshot) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        const binding = snapshot.data();
        setPlayerId(
          typeof binding?.playerId === "string"
            ? binding.playerId
            : typeof binding?.slot === "string"
              ? binding.slot
              : null,
        );
        setLoading(false);
      },
      (e) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        setError(message(e));
        setLoading(false);
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [uid]);
  useEffect(() => {
    setProfileReady(false);
    setPairsReady(false);
    setPairsServerReady(false);
    setPairs([]);
    setPairId(null);
    setSlot(null);
    setGame(null);
    setRack([]);
    if (!playerId) return;
    let disposed = false;
    const profileStop = onSnapshot(
      doc(db, "players", playerId),
      (snapshot) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        setDisplayName(
          snapshot.data()?.displayName || snapshot.data()?.name || playerId,
        );
        setDefaultPairId(snapshot.data()?.defaultPairId || null);
        setProfileReady(true);
      },
      (e) => {
        if (!disposed && auth.currentUser?.uid === uid) {
          setError(message(e));
          setProfileReady(true);
        }
      },
    );
    const listStop = onSnapshot(
      query(
        collection(db, "pairs"),
        where("memberIds", "array-contains", playerId),
      ),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        const next = snapshot.docs
          .map((record) => ({ ...record.data(), id: record.id }) as PairSummary)
          .sort((a, b) => a.id.localeCompare(b.id));
        setPairs(next);
        setPairsReady(true);
        setPairsServerReady(!snapshot.metadata.fromCache);
        setLoading(false);
      },
      (e) => {
        if (!disposed && auth.currentUser?.uid === uid) {
          setError(message(e));
          setPairsReady(true);
          setPairsServerReady(false);
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
      profileStop();
      listStop();
    };
  }, [playerId, uid]);
  useEffect(() => {
    if (!playerId || !pairs.length) {
      setPairId(null);
      return;
    }
    if (!profileReady) return;
    setPairId((current) => {
      if (current && pairs.some((pair) => pair.id === current)) return current;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(`tea-last-pair:${projectId}:${playerId}`);
      } catch {
        /* optional */
      }
      return (
        pairs.find((pair) => pair.id === saved)?.id ||
        pairs.find((pair) => pair.id === defaultPairId)?.id ||
        pairs[0].id
      );
    });
  }, [playerId, pairs, defaultPairId, profileReady]);
  useEffect(() => {
    setSlot(selectedSlot);
    if (selectedPair?.names) setNames(selectedPair.names);
  }, [selectedSlot, selectedPair?.names]);
  useEffect(() => {
    if (playerId && pairId)
      try {
        localStorage.setItem(`tea-last-pair:${projectId}:${playerId}`, pairId);
      } catch {
        /* optional */
      }
  }, [playerId, pairId]);
  const contextKey = `${projectId}:${playerId || ""}:${pairId || ""}:${activeGameId || ""}`;
  contextRef.current = `${uid || ""}:${contextKey}`;
  useEffect(() => {
    setGame(null);
    setRack([]);
    setError(null);
    setTimedClock(null);
    confirmedRef.current = null;
    storageKey.current =
      uid && pairId && activeGameId
        ? `tea-pending:${projectId}:${uid}:${pairId}:${activeGameId}`
        : "";
    const key = storageKey.current;
    let restored: Command | null = null;
    try {
      const stored = key && localStorage.getItem(key);
      if (stored) restored = JSON.parse(stored);
      // Preserve recovery for a move saved by the previous single-table build.
      if (!restored && uid && pairId === "family") {
        const legacy = localStorage.getItem(`tea-pending:${projectId}:${uid}`);
        const candidate = legacy ? JSON.parse(legacy) : null;
        if (candidate?.gameId === activeGameId) restored = candidate;
      }
    } catch {
      /* A malformed recovery record is ignored. */
    }
    if (restored && restored.gameId !== activeGameId) restored = null;
    try {
      savePending(restored, key);
    } catch (e) {
      // Reading an existing recovery record must not crash the table when storage is full.
      pendingRef.current = restored;
      setPending(restored);
      setError(message(e));
    }
    if (restored && uid && pairId === "family")
      try {
        localStorage.removeItem(`tea-pending:${projectId}:${uid}`);
      } catch {
        /* Recovery remains safe. */
      }
    if (!activeGameId || !selectedSlot || !pairId) return;
    let disposed = false;
    const listenerContext = contextRef.current;
    diagnostics.current?.recorder.listenerStart(activeGameId);
    const gameStop = onSnapshot(
      doc(db, "games", activeGameId),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (disposed || listenerContext !== contextRef.current) return;
        if (snapshot.exists()) {
          diagnostics.current?.recorder.snapshot(
            snapshot.data() as PublicGame,
            snapshot.metadata.fromCache,
          );
          setGame(snapshot.data() as PublicGame);
          if (!snapshot.metadata.fromCache) {
            setConnected(navigator.onLine);
            setError(null);
          }
        }
      },
      (e) => {
        if (disposed || listenerContext !== contextRef.current) return;
        diagnostics.current?.recorder.record("listener-error", {
          gameId: activeGameId,
          detail: e.code,
        });
        setError(message(e));
        setConnected(false);
      },
    );
    const rackStop = onSnapshot(
      doc(db, "games", activeGameId, "racks", selectedSlot),
      (snapshot) => {
        if (disposed || listenerContext !== contextRef.current) return;
        diagnostics.current?.recorder.record("rack-snapshot", {
          gameId: activeGameId,
        });
        setRack(snapshot.data()?.tiles || []);
      },
      (e) => {
        if (!disposed && listenerContext === contextRef.current)
          setError(message(e));
      },
    );
    return () => {
      disposed = true;
      gameStop();
      rackStop();
      diagnostics.current?.recorder.record("listener-stop", {
        gameId: activeGameId,
      });
    };
  }, [contextKey, uid, selectedSlot, savePending]);
  useEffect(() => {
    setEndGameRequests([]);
    setEndGameRequestsForGame(null);
    setEndGameRequestsReady(false);
    setEndGameRequestsError(null);
    if (!slot || !pairId || !game?.id) return;
    let knownRequests = false;
    let disposed = false;
    const listenerContext = contextRef.current;
    const stop = onSnapshot(
      query(
        collection(db, "pairs", pairId!, "endGameRequests"),
        where("gameId", "==", game.id),
      ),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (disposed || listenerContext !== contextRef.current) return;
        setEndGameRequests(
          snapshot.docs.map(
            (record) => ({ ...record.data(), id: record.id }) as EndGameRequest,
          ),
        );
        knownRequests ||= !snapshot.metadata.fromCache;
        setEndGameRequestsForGame(game.id);
        setEndGameRequestsReady(knownRequests);
        setEndGameRequestsError(null);
      },
      () => {
        if (disposed || listenerContext !== contextRef.current) return;
        setEndGameRequestsReady(false);
        setEndGameRequestsError(
          "End-game requests are unavailable. Please reconnect and reload.",
        );
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [slot, pairId, game?.id]);
  useEffect(() => {
    setNewGameRequests([]);
    setNewGameRequestsForGame(null);
    setNewGameRequestsReady(false);
    setNewGameRequestsError(null);
    if (!slot || !pairId || !game?.id) return;
    let knownRequests = false;
    let disposed = false;
    const listenerContext = contextRef.current;
    const stop = onSnapshot(
      query(
        collection(db, "pairs", pairId!, "gameRequests"),
        where("gameId", "==", game.id),
      ),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (disposed || listenerContext !== contextRef.current) return;
        setNewGameRequests(
          snapshot.docs.map(
            (record) => ({ ...record.data(), id: record.id }) as NewGameRequest,
          ),
        );
        knownRequests ||= !snapshot.metadata.fromCache;
        setNewGameRequestsForGame(game.id);
        setNewGameRequestsReady(knownRequests);
        setNewGameRequestsError(null);
      },
      () => {
        if (disposed || listenerContext !== contextRef.current) return;
        setNewGameRequestsReady(false);
        setNewGameRequestsError(
          "New game requests are unavailable. Please reconnect and reload.",
        );
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [slot, pairId, game?.id]);
  useEffect(() => {
    setHouseWords([]);
    setWordRequests([]);
    setDictionaryReady(false);
    setDictionaryError(null);
    if (!playerId) return;
    let knownSharedWords = false;
    let disposed = false;
    const stopWords = onSnapshot(
      collection(db, "houseWords"),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        setHouseWords(
          snapshot.docs.map(
            (record) => ({ ...record.data(), word: record.id }) as HouseWord,
          ),
        );
        // Initial empty memory cache doesn't prove there are no house words.
        // Once a server snapshot arrives, its words remain usable while offline.
        knownSharedWords ||= !snapshot.metadata.fromCache;
        setDictionaryReady(knownSharedWords);
        setDictionaryError(null);
      },
      (e) => {
        if (disposed || auth.currentUser?.uid !== uid) return;
        setHouseWords([]);
        setDictionaryReady(false);
        setDictionaryError("Shared word check unavailable.");
        setError(message(e));
      },
    );
    return () => {
      disposed = true;
      stopWords();
    };
  }, [playerId, uid]);
  useEffect(() => {
    setWordRequests([]);
    setWordRequestsReady(false);
    if (!pairId || !game?.id || !slot) return;
    let disposed = false;
    const listenerContext = contextRef.current;
    const stop = onSnapshot(
      query(
        collection(db, "pairs", pairId, "wordRequests"),
        where("gameId", "==", game.id),
      ),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!disposed && listenerContext === contextRef.current) {
          setWordRequests(
            snapshot.docs.map(
              (record) => ({ ...record.data(), id: record.id }) as WordRequest,
            ),
          );
          setWordRequestsReady(!snapshot.metadata.fromCache);
        }
      },
      (e) => {
        if (!disposed && listenerContext === contextRef.current) {
          setWordRequests([]);
          setWordRequestsReady(false);
          setError(message(e));
        }
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [pairId, game?.id, slot]);
  useEffect(() => {
    if (!pending || !uid || !slot) return;
    let disposed = false;
    const operationKey = storageKey.current;
    const operationContext = contextRef.current;
    const stop = onSnapshot(
      doc(db, "games", pending.gameId, "commands", pending.id),
      (s) => {
        if (
          disposed ||
          operationContext !== contextRef.current ||
          auth.currentUser?.uid !== uid
        )
          return;
        diagnostics.current?.recorder.record("receipt", {
          gameId: pending.gameId,
          moveId: pending.id,
          detail: s.exists() ? "confirmed" : "waiting",
        });
        if (s.exists() && s.data()?.uid === uid) {
          confirmedRef.current = s.data()?.result as CommandResult;
          savePending(null, operationKey);
          setError(null);
        }
      },
      () => {
        /* Retry callable if receipt listener is temporarily unavailable. */
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [pending, uid, slot, savePending]);
  const enroll = useCallback(
    async (code: string) => {
      setError(null);
      let operationUid = auth.currentUser?.uid;
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
        operationUid = auth.currentUser?.uid;
        await callShared("enrollPlayer", { code });
      } catch (e) {
        if (auth.currentUser?.uid === operationUid) setError(message(e));
        throw e;
      }
    },
    [callShared],
  );
  const signInPlayer = useCallback(
    async (playerId: string, passphrase: string) => {
      setError(null);
      let operationUid = auth.currentUser?.uid;
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
        operationUid = auth.currentUser?.uid;
        await callShared("loginPlayer", { playerId, passphrase });
      } catch (e) {
        if (auth.currentUser?.uid === operationUid) setError(message(e));
        throw e;
      }
    },
    [callShared],
  );
  const send = useCallback(
    async (command: Command): Promise<CommandResult> => {
      if (busy.current) throw new Error("A move is already being sent.");
      if (!navigator.onLine)
        throw new Error("Reconnect before saving your move.");
      const operationKey = storageKey.current;
      const operationContext = contextRef.current;
      const operationUid = auth.currentUser?.uid;
      const current = () =>
        operationContext === contextRef.current &&
        auth.currentUser?.uid === operationUid;
      const recorder = diagnostics.current?.recorder;
      savePending(command, operationKey);
      recorder?.submitStart(
        command.gameId,
        command.id,
        command.expectedRevision,
      );
      const owner = Symbol("submit");
      busyOwner.current = owner;
      busy.current = true;
      confirmedRef.current = null;
      setError(null);
      try {
        const result = await callShared<Command, CommandResult>(
          "submitCommand",
          command,
        );
        savePending(null, operationKey);
        recorder?.submitEnd(command.id);
        return result;
      } catch (e) {
        recorder?.submitEnd(
          command.id,
          (e as { code?: string }).code || "unknown",
        );
        if (!current()) throw e;
        const confirmed = confirmedRef.current as CommandResult | null;
        if (confirmed?.commandId === command.id) {
          resumeSharedActions();
          setError(null);
          return confirmed;
        }
        if (!retryable(e)) savePending(null, operationKey);
        const explainedRejection =
          !retryable(e) &&
          ["dictionary", "timed"].includes(
            (e as { details?: { rule?: string } })?.details?.rule || "",
          );
        setError(
          explainedRejection
            ? null
            : retryable(e)
              ? "Your move is taking a little longer. We haven’t heard back from the game server yet. Your letters are safe here. Tap Check my move to see whether it went through."
              : message(e),
        );
        throw e;
      } finally {
        if (busyOwner.current === owner) {
          busy.current = false;
          busyOwner.current = null;
        }
      }
    },
    [savePending, callShared, resumeSharedActions],
  );
  const submit = useCallback(
    (command: Command) => {
      if (pendingRef.current && pendingRef.current.id !== command.id)
        return Promise.reject(
          new Error("Confirm your submitted move before taking another turn."),
        );
      return send(command);
    },
    [send],
  );
  const retryPending = useCallback(async () => {
    if (pendingRef.current) return send(pendingRef.current);
  }, [send]);
  const requestWord = useCallback(
    async (word: string) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before asking to add a word.");
      if (pendingRef.current)
        throw new Error(
          "Confirm your submitted move before asking to add a word.",
        );
      return callShared<{ word: string }, { id: string }>("requestWord", {
        word,
      });
    },
    [callShared],
  );
  const respondToWord = useCallback(
    async (
      requestId: string,
      approve: boolean,
      expectedRequestedAt: number,
    ) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before reviewing a word.");
      if (pendingRef.current)
        throw new Error("Confirm your submitted move before reviewing a word.");
      return callShared<WordDecision, { status: "accepted" | "declined" }>(
        "respondToWord",
        { requestId, approve, expectedRequestedAt },
      );
    },
    [callShared],
  );
  const requestNewGame = useCallback(
    async (request: {
      id: string;
      gameId: string;
      winCondition?: WinCondition;
      durationMinutes?: number;
    }) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before asking for a new game.");
      if (pendingRef.current)
        throw new Error(
          "Confirm your submitted move before asking for a new game.",
        );
      return callShared<typeof request, { id: string }>(
        "requestNewGame",
        request,
      );
    },
    [callShared],
  );
  const respondToNewGame = useCallback(
    async (request: { requestId: string; approve: boolean }) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before reviewing a new game request.");
      if (pendingRef.current)
        throw new Error(
          "Confirm your submitted move before reviewing a new game request.",
        );
      return callShared<
        typeof request,
        { status: "accepted" | "declined"; newGameId?: string }
      >("respondToNewGame", request);
    },
    [callShared],
  );
  const requestEndGame = useCallback(
    async (request: {
      id: string;
      gameId: string;
      expectedRevision: number;
    }) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before asking to end the game.");
      if (pendingRef.current)
        throw new Error(
          "Confirm your submitted move before asking to end the game.",
        );
      return callShared<typeof request, { id: string }>(
        "requestEndGame",
        request,
      );
    },
    [callShared],
  );
  const respondToEndGame = useCallback(
    async (request: { requestId: string; approve: boolean }) => {
      if (!navigator.onLine)
        throw new Error("Reconnect before reviewing an end-game request.");
      if (pendingRef.current)
        throw new Error(
          "Confirm your submitted move before reviewing an end-game request.",
        );
      return callShared<typeof request, EndGameResponse>(
        "respondToEndGame",
        request,
      );
    },
    [callShared],
  );
  const finishTimedGame = useCallback(
    async (gameId: string) => {
      if (!navigator.onLine)
        throw new Error("Reconnect to confirm the final score.");
      return callShared<{ gameId: string }, TimedGameResult>(
        "finishTimedGame",
        { gameId },
      );
    },
    [callShared],
  );
  useEffect(() => {
    if (
      !slot ||
      !connected ||
      sharedPause ||
      !game ||
      game.winCondition !== "timed" ||
      game.status !== "active" ||
      !game.deadlineAt
    )
      return;
    const gameId = game.id;
    const timedContext = contextRef.current;
    const sync = createTimedGameSync({
      deadlineAt: game.deadlineAt,
      request: () => finishTimedGame(gameId),
      online: () => navigator.onLine,
      visible: () => document.visibilityState !== "hidden",
      paused: () => !!sharedPauseRef.current,
      onClock: (offset) => {
        if (contextRef.current === timedContext)
          setTimedClock({ gameId, offset });
      },
    });
    const resume = sync.resume;
    sync.start();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      sync.dispose();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [
    game?.id,
    game?.winCondition,
    game?.deadlineAt,
    game?.status,
    slot,
    connected,
    sharedPause,
    finishTimedGame,
  ]);
  const canLeaveTable = !pending && !mutationBusy && !busy.current;
  const selectPair = useCallback(
    (id: string) => {
      if (
        pendingRef.current ||
        busy.current ||
        mutationOperations.current.size > 0
      )
        throw new Error(
          "Please wait for your move to finish before changing tables.",
        );
      if (!pairs.some((pair) => pair.id === id))
        throw new Error("That table is unavailable.");
      if (id === pairId) return;
      setGame(null);
      setRack([]);
      setWordRequests([]);
      setNewGameRequests([]);
      setEndGameRequests([]);
      setPairId(id);
    },
    [pairs, pairId, mutationBusy],
  );
  const signOut = useCallback(async () => {
    if (
      pendingRef.current ||
      busy.current ||
      mutationOperations.current.size > 0
    )
      throw new Error(
        "Please wait for your move to finish before signing out.",
      );
    contextRef.current = "signed-out";
    setPlayerId(null);
    setSlot(null);
    setPairId(null);
    setPairs([]);
    setGame(null);
    setRack([]);
    setHouseWords([]);
    setWordRequests([]);
    setNewGameRequests([]);
    setEndGameRequests([]);
    setDisplayName("");
    setUid(null);
    setError(null);
    resumeSharedActions();
    await firebaseSignOut(auth);
  }, [mutationBusy, resumeSharedActions]);
  return {
    playerId,
    accountScope: playerId ? `${projectId}:${playerId}` : null,
    pairsServerReady,
    displayName,
    pairs,
    pairId,
    selectPair,
    signOut,
    canLeaveTable,
    mutationBusy,
    contextKey,
    noteMoveDisplayed,
    noteMovePresentation,
    slot,
    names: selectedPair?.names || names,
    game,
    rack,
    houseWords,
    wordRequests,
    wordRequestsReady,
    dictionaryReady,
    dictionaryError,
    requestWord,
    respondToWord,
    newGameRequests,
    newGameRequestsReady:
      newGameRequestsReady && newGameRequestsForGame === game?.id,
    newGameRequestsError,
    requestNewGame,
    respondToNewGame,
    endGameRequests,
    endGameRequestsReady:
      endGameRequestsReady && endGameRequestsForGame === game?.id,
    endGameRequestsError,
    requestEndGame,
    respondToEndGame,
    timedClockReady: !!game && timedClock?.gameId === game.id,
    serverTimeOffset:
      timedClock && timedClock.gameId === game?.id ? timedClock.offset : 0,
    loading: loading || (!!playerId && (!profileReady || !pairsReady)),
    connected,
    presenceStatus,
    configured,
    sharedActionsPaused: !!sharedPause,
    sharedActionMessage: sharedPause?.message ?? null,
    sharedActionsResumeAt: sharedPause?.resumeAt ?? null,
    resumeSharedActions,
    error,
    enroll,
    signInPlayer,
    submit,
    pending,
    retryPending,
  };
}
