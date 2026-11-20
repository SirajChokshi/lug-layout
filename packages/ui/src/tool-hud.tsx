import {
  altKeyName,
  commandSpec,
  toolHints,
  type EditorSnapshot,
  type PlaySnapshot,
  type ToolHint,
} from "@brr/client";
import { Chord, PLATFORM } from "./keys.tsx";

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
          <span className="tool-gesture">Hold</span>
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

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly play: PlaySnapshot;
}

export function ToolHud({ snapshot, play }: ToolHudProps) {
  const view = toolHints(snapshot, play);
  return (
    <div
      className="tool-hud"
      data-tone={view.tone}
      role="status"
      aria-live="polite"
      aria-busy={view.busy}
    >
      <span className="tool-title">
        {view.title}
        {view.detail !== null && <span className="tool-detail">{view.detail}</span>}
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
    </div>
  );
}
