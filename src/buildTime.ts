declare global {
  interface Window {
    __TEA_LOCAL_BUILD_TIME__?: string;
  }
}

const listeners = new Set<() => void>();
export function getBuildTime() {
  return import.meta.env.DEV
    ? window.__TEA_LOCAL_BUILD_TIME__ || import.meta.env.VITE_BUILD_TIME
    : import.meta.env.VITE_BUILD_TIME;
}
export function subscribeBuildTime(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (import.meta.env.DEV && import.meta.hot) {
  const hot = import.meta.hot;
  const update = (timestamp: string) => {
    window.__TEA_LOCAL_BUILD_TIME__ = timestamp;
    for (const listener of listeners) listener();
  };
  hot.on("tea-build-time", update);
  hot.dispose(() => hot.off("tea-build-time", update));
}
