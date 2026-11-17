import type { EditorSnapshot } from "@brr/client";
import { useEffect, useRef } from "react";

const CURSOR_OFFSET_PX = 18;

export function PlacementCursor({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const element = ref.current;
      if (!element) return;
      element.style.transform = `translate(${event.clientX + CURSOR_OFFSET_PX}px, ${event.clientY + CURSOR_OFFSET_PX}px)`;
    };
    window.addEventListener("pointermove", onPointerMove);
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  const feedback = snapshot.ghostFeedback;
  const message = snapshot.hover !== null || snapshot.track?.drag ? feedback?.message : null;
  return (
    <div ref={ref} className="placement-cursor" aria-live="polite">
      {message && feedback && (
        <span
          key={feedback.tone === "blocked" ? `blocked-${snapshot.refusals}` : feedback.tone}
          className={`placement-chip ${feedback.tone}`}
          role={feedback.tone === "blocked" ? "alert" : "status"}
        >
          {message}
        </span>
      )}
    </div>
  );
}

interface SoundToggleProps {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}

export function SoundToggle({ on, onChange }: SoundToggleProps) {
  return (
    <button
      type="button"
      className="sound-toggle"
      aria-pressed={on}
      title="Placement sounds"
      onClick={() => onChange(!on)}
    >
      {on ? "Sound on" : "Sound off"}
    </button>
  );
}
