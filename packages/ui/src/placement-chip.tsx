import { badgeText, placementFeedback, type EditorSnapshot } from "@brr/client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { pendingSearch, useLateCue } from "./late-cue.ts";

const CURSOR_OFFSET_PX = 18;
const EDGE_MARGIN_PX = 8;

interface PointerAt {
  x: number;
  y: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

function placeBeside(chip: HTMLElement, pointer: PointerAt): void {
  if (chip.hidden) return;
  const width = chip.offsetWidth;
  const height = chip.offsetHeight;
  const flipX = pointer.x + CURSOR_OFFSET_PX + width + EDGE_MARGIN_PX > window.innerWidth;
  const flipY = pointer.y + CURSOR_OFFSET_PX + height + EDGE_MARGIN_PX > window.innerHeight;
  const x = flipX ? pointer.x - CURSOR_OFFSET_PX - width : pointer.x + CURSOR_OFFSET_PX;
  const y = flipY ? pointer.y - CURSOR_OFFSET_PX - height : pointer.y + CURSOR_OFFSET_PX;
  const left = clamp(x, EDGE_MARGIN_PX, window.innerWidth - width - EDGE_MARGIN_PX);
  const top = clamp(y, EDGE_MARGIN_PX, window.innerHeight - height - EDGE_MARGIN_PX);
  chip.style.transform = `translate(${left}px, ${top}px)`;
}

function useBesidePointer(chip: RefObject<HTMLDivElement | null>, content: string): void {
  const pointer = useRef<PointerAt>({ x: 0, y: 0 });
  useEffect(() => {
    const follow = (event: MouseEvent): void => {
      pointer.current.x = event.clientX;
      pointer.current.y = event.clientY;
      if (chip.current) placeBeside(chip.current, pointer.current);
    };
    window.addEventListener("pointermove", follow, { passive: true });
    window.addEventListener("dragover", follow, { passive: true });
    return () => {
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("dragover", follow);
    };
  }, [chip]);
  useLayoutEffect(() => {
    if (content !== "" && chip.current) placeBeside(chip.current, pointer.current);
  }, [chip, content]);
}

export function PlacementChip({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const chip = useRef<HTMLDivElement>(null);
  const feedback = placementFeedback(snapshot);
  const pending = feedback?.tone === "pending";
  const cueShown = useLateCue(pending ? pendingSearch(snapshot) : null);
  const lines = pending && !cueShown ? [] : (feedback?.lines ?? []);
  const precise = feedback?.mode === "precise";
  useBesidePointer(chip, lines.map((line) => line.text).join("\n"));
  return (
    <div
      ref={chip}
      className="placement-chip"
      data-tone={feedback?.tone ?? ""}
      data-mode={feedback?.mode ?? ""}
      hidden={lines.length === 0}
      aria-hidden="true"
    >
      {precise && <p className="placement-chip-mode">Precise: exactly at the cursor</p>}
      {lines.map((line) => (
        <p key={`${line.kind} ${line.text}`} className="placement-chip-line" data-line={line.kind}>
          <span>{line.text}</span>
          {line.badges.map((badge) => (
            <span key={badge.badge} className="placement-chip-badge" data-badge={badge.badge}>
              {badgeText(badge)}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
