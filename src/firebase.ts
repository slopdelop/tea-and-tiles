import { useCallback, useEffect, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import { firestoreTransport } from "./firestoreTransport";
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
} from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  collection,
  onSnapshot,
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
import type { NewGameRequest, TimedGameResult } from "../shared/game-request";
export type PublicGame = Omit<Game, "racks" | "bag"> & {
  rackCounts: Record<Slot, number>;
  bagCount: number;
};
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
    [dictionaryError, setDictionaryError] = useState<string | null>(null),
    [newGameRequests, setNewGameRequests] = useState<NewGameRequest[]>([]),
    [newGameRequestsReady, setNewGameRequestsReady] = useState(false),
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
      const pause = sharedPauseRef.current;
      if (pause && (!pause.resumeAt || pause.resumeAt > Date.now()))
        throw new Error(pause.message);
      if (pause) resumeSharedActions();
      try {
        const result = await httpsCallable<Input, Output>(
          functions,
          name,
        )(input);
        return result.data;
      } catch (failure) {
        const issue = noteServiceFailure(failure);
        if (issue) {
          const original = failure as { code?: string; details?: unknown };
          throw Object.assign(new Error(issue.message), {
            code: original.code,
            details: original.details,
          });
        }
        throw failure;
      }
    },
    [noteServiceFailure, resumeSharedActions],
  );
  const [timedClock, setTimedClock] = useState<{
    gameId: string;
    offset: number;
  } | null>(null);
  const storageKey = useRef("");
  const savePending = useCallback((command: Command | null) => {
    if (storageKey.current) {
      if (command) {
        try {
          localStorage.setItem(storageKey.current, JSON.stringify(command));
        } catch {
          throw new Error(
            "Your iPad could not save this move for recovery. Free some storage and try again.",
          );
        }
      } else {
        try {
          localStorage.removeItem(storageKey.current);
        } catch {
          /* A stored confirmed command will reconcile again on reload. */
        }
      }
    }
    pendingRef.current = command;
    setPending(command);
  }, []);
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
      if (!user) {
        try {
          await signInAnonymously(auth);
        } catch (e) {
          setError(message(e));
          setLoading(false);
        }
        return;
      }
      storageKey.current = `tea-pending:${projectId}:${user.uid}`;
      try {
        const stored = localStorage.getItem(storageKey.current);
        savePending(stored ? JSON.parse(stored) : null);
      } catch {
        savePending(null);
      }
      setUid(user.uid);
    });
  }, [savePending]);
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      doc(db, "bindings", uid),
      (snapshot) => {
        const next = snapshot.data()?.slot;
        setSlot(next === "mom" || next === "aunt" ? next : null);
        setLoading(false);
      },
      (e) => {
        setError(message(e));
        setLoading(false);
      },
    );
  }, [uid]);
  useEffect(() => {
    if (!slot) {
      setGame(null);
      setRack([]);
      return;
    }
    let gameStop = () => {},
      rackStop = () => {};
    let activeId: string | null = null;
    const pairStop = onSnapshot(
      doc(db, "pairs", "family"),
      (snapshot) => {
        const pair = snapshot.data();
        if (!pair) return;
        setNames(pair.names || { mom: "Elizabeth", aunt: "Rita" });
        if (pair.activeGameId !== activeId) {
          activeId = pair.activeGameId;
          gameStop();
          rackStop();
          setGame(null);
          setRack([]);
          gameStop = onSnapshot(
            doc(db, "games", pair.activeGameId),
            { includeMetadataChanges: true },
            (s) => {
              if (s.exists()) {
                setGame(s.data() as PublicGame);
                if (!s.metadata.fromCache) {
                  setConnected(navigator.onLine);
                  setError(null);
                }
              }
            },
            (e) => {
              setError(message(e));
              setConnected(false);
            },
          );
          rackStop = onSnapshot(
            doc(db, "games", pair.activeGameId, "racks", slot),
            (s) => setRack(s.data()?.tiles || []),
            (e) => setError(message(e)),
          );
        }
      },
      (e) => setError(message(e)),
    );
    return () => {
      pairStop();
      gameStop();
      rackStop();
    };
  }, [slot]);
  useEffect(() => {
    setNewGameRequests([]);
    setNewGameRequestsReady(false);
    setNewGameRequestsError(null);
    if (!slot) return;
    let knownRequests = false;
    return onSnapshot(
      collection(db, "pairs", "family", "gameRequests"),
      { includeMetadataChanges: true },
      (snapshot) => {
        setNewGameRequests(
          snapshot.docs.map(
            (record) => ({ ...record.data(), id: record.id }) as NewGameRequest,
          ),
        );
        knownRequests ||= !snapshot.metadata.fromCache;
        setNewGameRequestsReady(knownRequests);
        setNewGameRequestsError(null);
      },
      () => {
        setNewGameRequestsReady(false);
        setNewGameRequestsError(
          "New game requests are unavailable. Please reconnect and reload.",
        );
      },
    );
  }, [slot]);
  useEffect(() => {
    setHouseWords([]);
    setWordRequests([]);
    setDictionaryReady(false);
    setDictionaryError(null);
    if (!slot) return;
    let knownSharedWords = false;
    const stopWords = onSnapshot(
      collection(db, "pairs", "family", "houseWords"),
      { includeMetadataChanges: true },
      (snapshot) => {
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
        setHouseWords([]);
        setDictionaryReady(false);
        setDictionaryError("Shared word check unavailable.");
        setError(message(e));
      },
    );
    const stopRequests = onSnapshot(
      collection(db, "pairs", "family", "wordRequests"),
      (snapshot) =>
        setWordRequests(
          snapshot.docs.map(
            (record) => ({ ...record.data(), id: record.id }) as WordRequest,
          ),
        ),
      (e) => {
        setWordRequests([]);
        setError(message(e));
      },
    );
    return () => {
      stopWords();
      stopRequests();
    };
  }, [slot]);
  useEffect(() => {
    if (!pending || !uid || !slot) return;
    return onSnapshot(
      doc(db, "games", pending.gameId, "commands", pending.id),
      (s) => {
        if (s.exists() && s.data()?.uid === uid) {
          confirmedRef.current = s.data()?.result as CommandResult;
          savePending(null);
          setError(null);
        }
      },
      () => {
        /* Retry callable if receipt listener is temporarily unavailable. */
      },
    );
  }, [pending, uid, slot, savePending]);
  const enroll = useCallback(
    async (code: string) => {
      setError(null);
      try {
        if (!auth.currentUser) await signInAnonymously(auth);
        await callShared("enrollPlayer", { code });
      } catch (e) {
        setError(message(e));
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
      savePending(command);
      busy.current = true;
      confirmedRef.current = null;
      setError(null);
      try {
        const result = await callShared<Command, CommandResult>(
          "submitCommand",
          command,
        );
        savePending(null);
        return result;
      } catch (e) {
        const confirmed = confirmedRef.current as CommandResult | null;
        if (confirmed?.commandId === command.id) {
          resumeSharedActions();
          setError(null);
          return confirmed;
        }
        if (!retryable(e)) savePending(null);
        const explainedRejection =
          !retryable(e) &&
          ["dictionary", "timed"].includes(
            (e as { details?: { rule?: string } })?.details?.rule || "",
          );
        setError(
          explainedRejection
            ? null
            : retryable(e)
              ? "Your move was submitted, but its reply is uncertain. Reconnect or retry to confirm it."
              : message(e),
        );
        throw e;
      } finally {
        busy.current = false;
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
    const gameId = game.id,
      deadline = game.deadlineAt;
    let stopped = false,
      inFlight = false,
      retryDelay = 1000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timeout);
      if (!stopped) timeout = setTimeout(check, delay);
    };
    const check = async () => {
      if (stopped || inFlight || !navigator.onLine) return;
      inFlight = true;
      const started = Date.now();
      try {
        const result = await finishTimedGame(gameId);
        if (stopped) return;
        const offset = result.serverNow - (started + Date.now()) / 2;
        setTimedClock({ gameId, offset });
        retryDelay = 1000;
        if (result.status === "active") {
          // Server time, not the device clock, determines expiry. A minimum
          // retry delay avoids a hot loop if a request reaches it just early.
          schedule(Math.max(1000, deadline - (Date.now() + offset) + 50));
        }
      } catch {
        // Expiration is idempotent. Recover quietly after a lost reply or
        // temporary disconnect; the game listener remains authoritative.
        if (!stopped && !sharedPauseRef.current) {
          schedule(retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      } finally {
        inFlight = false;
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      retryDelay = 1000;
      clearTimeout(timeout);
      void check();
    };
    void check();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      stopped = true;
      clearTimeout(timeout);
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
  return {
    slot,
    names,
    game,
    rack,
    houseWords,
    wordRequests,
    dictionaryReady,
    dictionaryError,
    requestWord,
    respondToWord,
    newGameRequests,
    newGameRequestsReady,
    newGameRequestsError,
    requestNewGame,
    respondToNewGame,
    timedClockReady: !!game && timedClock?.gameId === game.id,
    serverTimeOffset:
      timedClock && timedClock.gameId === game?.id ? timedClock.offset : 0,
    loading,
    connected,
    configured,
    sharedActionsPaused: !!sharedPause,
    sharedActionMessage: sharedPause?.message ?? null,
    sharedActionsResumeAt: sharedPause?.resumeAt ?? null,
    resumeSharedActions,
    error,
    enroll,
    submit,
    pending,
    retryPending,
  };
}
