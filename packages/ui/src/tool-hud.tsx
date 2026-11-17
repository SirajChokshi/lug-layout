import {
  commandSpec,
  toolHints,
  type EditorSnapshot,
  type PlaySnapshot,
  type ToolHint,
} from "@brr/client";
import { Chord } from "./keys.tsx";

function hintKey(hint: ToolHint): string {
  return hint.kind === "key" ? hint.command : hint.gesture;
}

function HintInput({ hint }: { readonly hint: ToolHint }) {
  if (hint.kind === "gesture") return <span className="tool-gesture">{hint.gesture}</span>;
  const [chord] = commandSpec(hint.command).keys;
  return chord ? <Chord chord={chord} /> : null;
}

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly play: PlaySnapshot;
}

export function ToolHud({ snapshot, play }: ToolHudProps) {
  const view = toolHints(snapshot, play);
  return (
    <div className="tool-hud" data-tone={view.tone} role="status" aria-live="polite">
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
