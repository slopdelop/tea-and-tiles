import { useEffect, useState } from "react";
import dictionaryUrl from "../../shared/words.txt?url";

let loadedDictionary: Set<string> | null = null;
let loadingDictionary: Promise<Set<string>> | null = null;

// One public static download, shared by mounted views. Draft words stay on this
// device; checking each placement doesn't invoke a Function or Firestore read.
function loadDictionary(): Promise<Set<string>> {
  if (loadedDictionary) return Promise.resolve(loadedDictionary);
  if (loadingDictionary) return loadingDictionary;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  loadingDictionary = fetch(dictionaryUrl, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("Dictionary could not be loaded.");
      const words = (await response.text())
        .split(/\r?\n/)
        .map((word) => word.trim().toUpperCase())
        .filter(Boolean);
      // A missing asset must never turn an HTML fallback into a word list or
      // make every real word appear unrecognized.
      if (
        words.length < 1000 ||
        words.some((word) => !/^[A-Z]{2,15}$/.test(word))
      ) {
        throw new Error("Dictionary could not be loaded.");
      }
      loadedDictionary = new Set(words);
      return loadedDictionary;
    })
    .catch((error: unknown) => {
      loadingDictionary = null;
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  return loadingDictionary;
}

export function useWordDictionary() {
  const [dictionary, setDictionary] = useState<Set<string> | null>(
    loadedDictionary,
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void loadDictionary().then(
      (words) => {
        if (active) setDictionary(words);
      },
      () => {
        if (active)
          setError(
            "Word check unavailable. You can still try Play when connected.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (!error) return;
    const retryOnReconnect = () => setAttempt((value) => value + 1);
    window.addEventListener("online", retryOnReconnect);
    return () => window.removeEventListener("online", retryOnReconnect);
  }, [error]);
  return { dictionary, error, retry: () => setAttempt((value) => value + 1) };
}
