import { trackRefusalMessage, type EditorSnapshot, type GhostFeedbackView } from "@brr/client";
import { useEffect, useRef, useState } from "react";

const CURSOR_OFFSET_PX = 18;
const TRACK_REFUSAL_MS = 1800;

interface Chip {
  readonly key: string;
  readonly tone: GhostFeedbackView["tone"];
  readonly message: string;
}

function useTrackRefusalChip(snapshot: EditorSnapshot): Chip | null {
  const refusals = snapshot.track?.refusals ?? 0;
  const [seen, setSeen] = useState(refusals);
  const [chip, setChip] = useState<Chip | null>(null);
  if (refusals !== seen) {
    setSeen(refusals);
    const message =
      refusals > seen ? trackRefusalMessage(snapshot.track?.lastCommit ?? null) : null;
    setChip(message === null ? null : { key: `track-${refusals}`, tone: "blocked", message });
  }
  useEffect(() => {
    if (!chip) return;
    const timer = setTimeout(() => setChip(null), TRACK_REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [chip]);
  return chip;
}

function useToneAnnouncement(chip: Chip | null): string {
  const tone = chip?.tone ?? null;
  const [announced, setAnnounced] = useState<{
    readonly tone: Chip["tone"] | null;
    readonly message: string;
  }>({ tone: null, message: "" });
  if (tone !== announced.tone) setAnnounced({ tone, message: chip?.message ?? "" });
  return announced.message;
}

function ghostChip(snapshot: EditorSnapshot): Chip | null {
  const feedback = snapshot.ghostFeedback;
  const pointing = snapshot.hover !== null || snapshot.track?.drag;
  if (!pointing || !feedback?.message) return null;
  return {
    key: feedback.tone === "blocked" ? `blocked-${snapshot.refusedClicks}` : feedback.tone,
    tone: feedback.tone,
    message: feedback.message,
  };
}

export function PlacementCursor({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const trackChip = useTrackRefusalChip(snapshot);
  const chip = ghostChip(snapshot) ?? trackChip;
  const announcement = useToneAnnouncement(chip);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const element = ref.current;
      if (!element) return;
      element.style.transform = `translate(${event.clientX + CURSOR_OFFSET_PX}px, ${event.clientY + CURSOR_OFFSET_PX}px)`;
    };
    window.addEventListener("pointermove", onPointerMove);
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  return (
    <div className="placement-cursor-layer">
      <div ref={ref} className="placement-cursor" aria-hidden="true">
        {chip && (
          <span key={chip.key} className={`placement-chip ${chip.tone}`}>
            {chip.message}
          </span>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
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
