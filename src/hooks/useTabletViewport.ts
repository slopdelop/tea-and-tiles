import { useLayoutEffect, useState } from "react";
import { installResumeZoomRecovery } from "./resumeZoomRecovery";

/** Fit the active tablet table without changing the user's browser zoom. */
export function useTabletViewport(enabled: boolean) {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("tablet-page-fitted", fits);
    return () =>
      document.documentElement.classList.remove("tablet-page-fitted");
  }, [fits]);
  useLayoutEffect(() => {
    if (!enabled) {
      setFits(false);
      return;
    }
    let frame = 0;
    const media = matchMedia("(any-pointer: coarse) and (min-width: 700px)");
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shell = document.querySelector<HTMLElement>(
          ".app-shell.active-game",
        );
        const board = shell?.querySelector<HTMLElement>(".board-frame");
        const play = shell?.querySelector<HTMLElement>(".play-area");
        const sidebar = shell?.querySelector<HTMLElement>(".game-sidebar");
        const layout = shell?.querySelector<HTMLElement>(".game-layout");
        const header = shell?.querySelector<HTMLElement>(
          ":scope > .app-header",
        );
        if (
          !shell ||
          !board ||
          !play ||
          !sidebar ||
          !layout ||
          !media.matches
        ) {
          setFits(false);
          return;
        }
        const viewport = window.visualViewport;
        // A pinch is not a change in available layout space. Reflow only at
        // normal browser scale; Safari may retain user zoom for accessibility.
        const height =
          viewport && Math.abs(viewport.scale - 1) < 0.01
            ? viewport.height
            : window.innerHeight;
        const shellCss = getComputedStyle(shell);
        const layoutCss = getComputedStyle(layout);
        const padding =
          parseFloat(shellCss.paddingTop) + parseFloat(shellCss.paddingBottom);
        const headerHeight = header
          ? header.offsetHeight +
            parseFloat(getComputedStyle(header).marginBottom)
          : 0;
        const oneColumn = layoutCss.gridTemplateColumns.split(" ").length === 1;
        const extra =
          play.offsetHeight -
          board.offsetHeight +
          (oneColumn ? sidebar.offsetHeight + parseFloat(layoutCss.rowGap) : 0);
        const available = Math.floor(
          height - padding - headerHeight - extra - 6,
        );
        const sidebarFits =
          oneColumn || sidebar.offsetHeight + padding + headerHeight <= height;
        const canFit =
          height >= 650 &&
          available >= 330 &&
          sidebarFits &&
          !document.activeElement?.matches("input, textarea, select");
        shell.style.setProperty("--tablet-height", `${Math.floor(height)}px`);
        shell.style.setProperty(
          "--tablet-board-size",
          `${Math.max(330, available)}px`,
        );
        setFits(canFit);
        if (
          canFit &&
          !document.querySelector('[role="dialog"]') &&
          Math.abs(viewport?.scale ?? 1) === 1
        )
          window.scrollTo(0, 0);
      });
    };
    const preventZoom = (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".app-shell.active-game, .modal-backdrop")
      )
        return;
      if (
        event.type.startsWith("gesture") ||
        (event instanceof TouchEvent && event.touches.length > 1)
      )
        event.preventDefault();
    };
    const stopZoomRecovery = installResumeZoomRecovery(
      window,
      document,
      measure,
    );
    const observer = new ResizeObserver(measure);
    document
      .querySelectorAll(".app-header, .game-sidebar, .hand-row")
      .forEach((element) => observer.observe(element));
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("pageshow", measure);
    document.addEventListener("visibilitychange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    document.addEventListener("focusin", measure);
    document.addEventListener("focusout", measure);
    document.addEventListener("gesturestart", preventZoom, { passive: false });
    document.addEventListener("gesturechange", preventZoom, { passive: false });
    document.addEventListener("touchmove", preventZoom, { passive: false });
    return () => {
      stopZoomRecovery();
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("pageshow", measure);
      document.removeEventListener("visibilitychange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("focusout", measure);
      document.removeEventListener("gesturestart", preventZoom);
      document.removeEventListener("gesturechange", preventZoom);
      document.removeEventListener("touchmove", preventZoom);
    };
  }, [enabled]);
  return fits;
}
