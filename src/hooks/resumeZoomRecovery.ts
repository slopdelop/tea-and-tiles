/** Recover WebKit's unwanted magnification when an installed iPad app resumes.
 * This is a viewport hint, not a browser API that guarantees zoom recovery.
 */
export function installResumeZoomRecovery(
  win: Window,
  doc: Document,
  settled: () => void,
) {
  const nav = win.navigator;
  const isIOS =
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const standalone =
    win.matchMedia("(display-mode: standalone)").matches ||
    (nav as Navigator & { standalone?: boolean }).standalone === true;
  if (!isIOS || !standalone) return () => {};

  let healthyBeforeBackground = (win.visualViewport?.scale ?? 1) <= 1.01;
  let timers: number[] = [];
  let frame = 0;
  let restore: (() => void) | undefined;
  let attempts = 0;
  const cancel = () => {
    timers.forEach((timer) => win.clearTimeout(timer));
    timers = [];
    win.cancelAnimationFrame(frame);
    restore?.();
  };
  const check = () => {
    if (
      doc.visibilityState !== "visible" ||
      !healthyBeforeBackground ||
      restore ||
      attempts >= 2 ||
      doc.activeElement?.matches(
        "input, textarea, select, [contenteditable='true']",
      )
    )
      return;
    const scale = win.visualViewport?.scale;
    if (!scale || !Number.isFinite(scale) || scale <= 1.01) return;
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.getAttribute("content");
    attempts++;
    restore = () => {
      if (original === null) meta.removeAttribute("content");
      else meta.setAttribute("content", original);
      restore = undefined;
    };
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
    );
    const finish = () => {
      if (!restore) return;
      win.cancelAnimationFrame(frame);
      restore();
      settled();
    };
    // Let WebKit apply the temporary constraints before restoring them. The
    // timeout also cleans up if rendering is suspended between these frames.
    frame = win.requestAnimationFrame(() => {
      frame = win.requestAnimationFrame(finish);
    });
    timers.push(win.setTimeout(finish, 120));
  };
  const resume = () => {
    cancel();
    if (doc.visibilityState !== "visible") return;
    attempts = 0;
    // iOS can restore its old scale after the first foreground event.
    [0, 80, 250, 700, 1500].forEach((delay) => {
      timers.push(win.setTimeout(check, delay));
    });
  };
  const visibility = () => {
    if (doc.visibilityState !== "visible") {
      healthyBeforeBackground = (win.visualViewport?.scale ?? 1) <= 1.01;
      cancel();
    } else resume();
  };
  doc.addEventListener("visibilitychange", visibility);
  win.addEventListener("pageshow", resume);
  return () => {
    doc.removeEventListener("visibilitychange", visibility);
    win.removeEventListener("pageshow", resume);
    cancel();
  };
}
