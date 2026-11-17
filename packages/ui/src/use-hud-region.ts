import { hudRegion, type HudFit, type HudRegion, type PanelRect } from "@brr/client";
import { useEffect, useState, type RefObject } from "react";

const HUD_FIT: HudFit = { minWidthPx: 180, minHeightPx: 72, usefulHeightPx: 260 };

function isOverlayPanel(element: Element, band: Element): element is HTMLElement {
  if (element === band || !(element instanceof HTMLElement)) return false;
  if (element.classList.contains("scene") || element.classList.contains("overlay")) return false;
  return getComputedStyle(element).position === "fixed";
}

function measure(band: HTMLElement): HudRegion | null {
  const root = band.parentElement;
  if (!root) return null;
  const elements = [...root.children].filter((element) => isOverlayPanel(element, band));
  const footer = elements.find((element) => element.tagName === "FOOTER");
  const floor = footer ? footer.getBoundingClientRect().top : window.innerHeight;
  const panels: PanelRect[] = elements
    .filter((element) => element !== footer)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  return hudRegion(window.innerWidth, floor, panels, HUD_FIT);
}

function sameRegion(a: HudRegion | null, b: HudRegion | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
}

export function useHudRegion(bandRef: RefObject<HTMLElement | null>): HudRegion | null {
  const [region, setRegion] = useState<HudRegion | null>(null);
  useEffect(() => {
    const band = bandRef.current;
    const root = band?.parentElement;
    if (!band || !root) return;
    const update = (): void => {
      const next = measure(band);
      setRegion((current) => (sameRegion(current, next) ? current : next));
    };
    const resizes = new ResizeObserver(update);
    const observePanels = (): void => {
      resizes.disconnect();
      for (const element of root.children) {
        if (isOverlayPanel(element, band)) resizes.observe(element);
      }
      update();
    };
    const children = new MutationObserver(observePanels);
    children.observe(root, { childList: true });
    window.addEventListener("resize", update);
    observePanels();
    return () => {
      children.disconnect();
      resizes.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [bandRef]);
  return region;
}
