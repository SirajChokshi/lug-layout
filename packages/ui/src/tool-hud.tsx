import {
  altKeyName,
  commandSpec,
  toolHints,
  type EditorSnapshot,
  type PlaySnapshot,
  type ToolHint,
  type ToolHintView,
  type ToolSpeech,
} from "@brr/client";
import { Chord, PLATFORM } from "./keys.tsx";
import { pendingSearch, useLateCue, useSteadySpeech } from "./late-cue.ts";

function hintKey(hint: ToolHint): string {
  switch (hint.kind) {
    case "key":
      return hint.command;
    case "gesture":
      return hint.gesture;
    case "hold-alt":
      return hint.kind;
    default: {
      const unhandled: never = hint;
      throw new Error(`unhandled hint ${String(unhandled)}`);
    }
  }
}

function HintInput({ hint }: { readonly hint: ToolHint }) {
  switch (hint.kind) {
    case "gesture":
      return <span className="tool-gesture">{hint.gesture}</span>;
    case "hold-alt":
      return (
        <span className="chord">
          <span className="tool-gesture">{hint.held ? "Release" : "Hold"}</span>
          <kbd>{altKeyName(PLATFORM)}</kbd>
        </span>
      );
    case "key": {
      const [chord] = commandSpec(hint.command).keys;
      return chord ? <Chord chord={chord} /> : null;
    }
    default: {
      const unhandled: never = hint;
      throw new Error(`unhandled hint ${String(unhandled)}`);
    }
  }
}

interface PlacementSpeechProps {
  readonly speech: ToolSpeech | null;
  readonly busy: boolean;
}

function PlacementSpeech({ speech, busy }: PlacementSpeechProps) {
  const verdict = useSteadySpeech(speech?.verdict ?? null);
  const turn = useSteadySpeech(speech?.turn ?? null);
  return (
    <>
      <span
        className="tool-speech"
        data-speech="verdict"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={busy}
      >
        {verdict}
      </span>
      <span
        className="tool-speech"
        data-speech="turn"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {turn}
      </span>
    </>
  );
}

function shownDetail(view: ToolHintView, cued: boolean): string | null {
  if (view.detail === null || view.waiting === null || !cued) return view.detail;
  return `${view.detail} · ${view.waiting}`;
}

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly play: PlaySnapshot;
}

export function ToolHud({ snapshot, play }: ToolHudProps) {
  const view = toolHints(snapshot, play);
  const cued = useLateCue(view.waiting === null ? null : pendingSearch(snapshot));
  const detail = shownDetail(view, cued);
  return (
    <div
      className="tool-hud"
      data-tone={view.tone}
      role="status"
      aria-live={view.speech === null ? "polite" : "off"}
    >
      <span className="tool-title">
        {view.title}
        {detail !== null && <span className="tool-detail">{detail}</span>}
      </span>
      {view.hints.length > 0 && (
        <ul className="tool-hints">
          {view.hints.map((hint) => (
            <li key={hintKey(hint)} data-hint={hintKey(hint)}>
              <HintInput hint={hint} />
              <span>{hint.text}</span>
            </li>
          ))}
        </ul>
      )}
      <PlacementSpeech speech={view.speech} busy={view.busy} />
    </div>
  );
}
