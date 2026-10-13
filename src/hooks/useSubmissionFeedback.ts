import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface SubmissionFeedbackClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface FeedbackState {
  commandId: string | null;
  visible: boolean;
}

const browserClock: SubmissionFeedbackClock = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
};

export const SUBMISSION_NOTICE_DELAY_MS = 4000;

/** Notice lifecycle only: this never cancels or changes the pending command. */
export function createSubmissionFeedback(
  clock: SubmissionFeedbackClock,
  onChange: (state: FeedbackState) => void,
) {
  let state: FeedbackState = { commandId: null, visible: false };
  let timer: unknown;
  let generation = 0;
  let disposed = false;
  const clearTimer = () => {
    generation += 1;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const publish = (next: FeedbackState) => {
    state = next;
    onChange(next);
  };
  return {
    setCommand(commandId: string | null, delayMs = SUBMISSION_NOTICE_DELAY_MS) {
      if (disposed || state.commandId === commandId) return;
      clearTimer();
      publish({ commandId, visible: false });
      if (commandId === null) return;
      const scheduledGeneration = generation;
      timer = clock.setTimeout(() => {
        if (disposed || scheduledGeneration !== generation) return;
        timer = undefined;
        publish({ commandId, visible: true });
      }, delayMs);
    },
    dismiss() {
      if (disposed) return;
      clearTimer();
      publish({ ...state, visible: false });
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

/** Opens only for a slow command; clearing its receipt immediately hides it. */
export function useSubmissionFeedback(
  commandId: string | null,
  delayMs = SUBMISSION_NOTICE_DELAY_MS,
): { visible: boolean; dismiss: () => void } {
  const [state, setState] = useState<FeedbackState>({
    commandId: null,
    visible: false,
  });
  const controller = useRef<ReturnType<typeof createSubmissionFeedback> | null>(
    null,
  );
  useLayoutEffect(() => {
    const lifecycle = createSubmissionFeedback(browserClock, setState);
    controller.current = lifecycle;
    return () => {
      lifecycle.dispose();
      controller.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    controller.current?.setCommand(commandId, delayMs);
  }, [commandId, delayMs]);
  const dismiss = useCallback(() => controller.current?.dismiss(), []);
  return {
    visible:
      commandId !== null && state.commandId === commandId && state.visible,
    dismiss,
  };
}
