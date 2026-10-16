import { useEffect, useRef, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  type Firestore,
} from "firebase/firestore";
import type { Slot } from "../../shared/engine";
import {
  nextOnlineHeartbeat,
  readOnlinePresence,
  type OnlinePresence,
} from "../../shared/online-time";
import {
  PRESENCE_HEARTBEAT_MS,
  presenceUpdate,
  UNKNOWN_PRESENCE,
  type PresenceDevice,
} from "../presence";
export function usePlayerPresence(
  db: Firestore,
  uid: string | null,
  slot: Slot | null,
  enabled: boolean,
  connected: boolean,
  gameStartedAt?: number,
) {
  const [status, setStatus] = useState(UNKNOWN_PRESENCE);
  const publishedStatus = useRef(status);
  const inFlight = useRef(false);
  const lastAttempt = useRef(0);
  const serverOffset = useRef(0);
  const pendingOwnWrite = useRef(false);
  const sentAt = useRef(0);
  const gameStart = useRef(gameStartedAt);
  gameStart.current = gameStartedAt;
  useEffect(() => {
    if (publishedStatus.current !== UNKNOWN_PRESENCE) {
      publishedStatus.current = UNKNOWN_PRESENCE;
      setStatus(UNKNOWN_PRESENCE);
    }
    if (!uid || !slot || !enabled || !connected) return;
    const storageKey = `tea-presence:${db.app.options.projectId}:${uid}`;
    try {
      lastAttempt.current = Number(localStorage.getItem(storageKey)) || 0;
    } catch {
      /* Storage is optional. */
    }
    let disposed = false;
    let ownReady = false;
    let ownActivity: OnlinePresence | null = null;
    let wakeHeartbeat = () => {};
    let devices: PresenceDevice[] | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshPresence = () => {
      clearTimeout(expiryTimer);
      if (disposed) return;
      const now = Date.now() + serverOffset.current;
      const update = presenceUpdate(devices, now, publishedStatus.current);
      if (update.status !== publishedStatus.current) {
        publishedStatus.current = update.status;
        setStatus(update.status);
      }
      if (
        document.visibilityState === "visible" &&
        update.nextChangeAt !== null
      )
        expiryTimer = setTimeout(
          refreshPresence,
          Math.min(2_147_483_647, Math.max(1, update.nextChangeAt - now)),
        );
    };
    const stop = onSnapshot(
      collection(db, "pairs", "family", "presence"),
      { includeMetadataChanges: true },
      (snapshot) => {
        const own = snapshot.docs.find((device) => device.id === uid);
        if (own?.metadata.hasPendingWrites) pendingOwnWrite.current = true;
        const ownSeen = own?.data().lastSeen?.toMillis?.();
        if (!snapshot.metadata.fromCache && !own?.metadata.hasPendingWrites) {
          ownActivity = readOnlinePresence(own?.data());
          const first = !ownReady;
          ownReady = true;
          if (first)
            queueMicrotask(() => {
              if (!disposed) wakeHeartbeat();
            });
        }
        if (
          pendingOwnWrite.current &&
          own &&
          !own.metadata.hasPendingWrites &&
          typeof ownSeen === "number"
        ) {
          serverOffset.current = ownSeen - (sentAt.current + Date.now()) / 2;
          pendingOwnWrite.current = false;
        }
        if (snapshot.metadata.fromCache) {
          devices = null;
          refreshPresence();
          return;
        }
        devices = snapshot.docs.flatMap((device) => {
          const data = device.data();
          const lastSeen = data.lastSeen?.toMillis?.();
          return (data.slot === "mom" || data.slot === "aunt") &&
            typeof lastSeen === "number"
            ? [{ slot: data.slot as Slot, lastSeen }]
            : [];
        });
        refreshPresence();
      },
      () => {
        devices = null;
        refreshPresence();
      },
    );
    const heartbeat = () => {
      if (
        disposed ||
        !connected ||
        !navigator.onLine ||
        document.visibilityState !== "visible" ||
        inFlight.current ||
        !ownReady
      )
        return PRESENCE_HEARTBEAT_MS;
      const time = Date.now();
      try {
        lastAttempt.current = Math.max(
          lastAttempt.current,
          Number(localStorage.getItem(storageKey)) || 0,
        );
      } catch {
        /* Storage is optional. */
      }
      // Recover if the device's wall clock was corrected backwards.
      if (lastAttempt.current > time + PRESENCE_HEARTBEAT_MS)
        lastAttempt.current = 0;
      if (time - lastAttempt.current < PRESENCE_HEARTBEAT_MS)
        return Math.max(
          1_000,
          PRESENCE_HEARTBEAT_MS - (time - lastAttempt.current),
        );
      lastAttempt.current = time;
      sentAt.current = time;
      try {
        localStorage.setItem(storageKey, String(time));
      } catch {
        /* In-memory throttling remains. */
      }
      inFlight.current = true;
      const activity = nextOnlineHeartbeat(
        ownActivity,
        time + serverOffset.current,
        gameStart.current,
      );
      void setDoc(doc(db, "pairs", "family", "presence", uid), {
        slot,
        lastSeen: serverTimestamp(),
        onlineSince:
          activity.continuing && ownActivity
            ? Timestamp.fromMillis(ownActivity.since)
            : serverTimestamp(),
        onlineTrackedFrom:
          activity.trackedFrom === null
            ? serverTimestamp()
            : Timestamp.fromMillis(activity.trackedFrom),
        onlineIntervals: activity.intervals,
      })
        .catch(() => {
          /* Presence failure never blocks a game command. */
        })
        .finally(() => {
          inFlight.current = false;
        });
      return PRESENCE_HEARTBEAT_MS;
    };
    let heartbeatTimer: ReturnType<typeof setTimeout>;
    const cycle = () => {
      clearTimeout(heartbeatTimer);
      // No React clock tick: check for clock corrections alongside the existing
      // heartbeat, and schedule one local timeout for the next label change.
      refreshPresence();
      heartbeatTimer = setTimeout(cycle, heartbeat());
    };
    const wake = () => {
      cycle();
    };
    wakeHeartbeat = cycle;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    cycle();
    return () => {
      disposed = true;
      stop();
      clearTimeout(heartbeatTimer);
      clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
    };
  }, [db, uid, slot, enabled, connected]);
  return connected && enabled ? status : UNKNOWN_PRESENCE;
}
