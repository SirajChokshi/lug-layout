import { badgeText, placementFeedback, type EditorSnapshot } from "@brr/client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const CURSOR_OFFSET_PX = 18;
const EDGE_MARGIN_PX = 8;

interface PointerAt {
  x: number;
  y: number;
}

function placeBeside(chip: HTMLElement, pointer: PointerAt): void {
  const width = chip.offsetWidth;
  const height = chip.offsetHeight;
  const flipX = pointer.x + CURSOR_OFFSET_PX + width + EDGE_MARGIN_PX > window.innerWidth;
  const flipY = pointer.y + CURSOR_OFFSET_PX + height + EDGE_MARGIN_PX > window.innerHeight;
  const x = flipX ? pointer.x - CURSOR_OFFSET_PX - width : pointer.x + CURSOR_OFFSET_PX;
  const y = flipY ? pointer.y - CURSOR_OFFSET_PX - height : pointer.y + CURSOR_OFFSET_PX;
  chip.style.transform = `translate(${Math.max(EDGE_MARGIN_PX, x)}px, ${Math.max(EDGE_MARGIN_PX, y)}px)`;
}

function useBesidePointer(chip: RefObject<HTMLDivElement | null>): void {
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
    if (chip.current) placeBeside(chip.current, pointer.current);
  });
}

export function PlacementChip({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const chip = useRef<HTMLDivElement>(null);
  useBesidePointer(chip);
  const feedback = placementFeedback(snapshot);
  const lines = feedback?.lines ?? [];
  return (
    <div
      ref={chip}
      className="placement-chip"
      data-tone={feedback?.tone ?? ""}
      hidden={lines.length === 0}
      aria-hidden="true"
    >
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
