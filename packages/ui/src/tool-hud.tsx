import {
  altKeyName,
  commandSpec,
  hotbarView,
  toolHints,
  type EditorSnapshot,
  type HotbarSlotView,
  type IHotbar,
  type PlaySnapshot,
  type ToolHint,
  type ToolHintView,
  type ToolSpeech,
} from "@brr/client";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Chord, PLATFORM } from "./keys.tsx";
import { pendingSearch, useLateCue, useSteadySpeech } from "./late-cue.ts";
import { useHotbarSnapshot } from "./use-hotbar.ts";

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly play: PlaySnapshot;
  readonly hotbar: IHotbar;
  readonly hotbarShown: boolean;
}

interface HotbarSlotsProps {
  readonly snapshot: EditorSnapshot;
  readonly hotbar: IHotbar;
  readonly slots: ReadonlyArray<HotbarSlotView>;
}

interface SlotButtonProps {
  readonly slot: HotbarSlotView;
  readonly keyLabel: string;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
}

const SHAPE_PX = 22;
const MIN_SHAPE_PX = 6;

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

function shapeSide(share: number): number {
  return Math.max(MIN_SHAPE_PX, Math.round(SHAPE_PX * share));
}

function shapeStyle({ footprint, color }: HotbarSlotView): CSSProperties {
  const size = footprint
    ? { width: shapeSide(footprint.wideShare), height: shapeSide(footprint.deepShare) }
    : { width: SHAPE_PX, height: SHAPE_PX };
  return color === null ? size : { ...size, background: color };
}

function SlotButton({ slot, keyLabel, pressed, disabled, onPick }: SlotButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pressed) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pressed]);
  const { footprint } = slot;
  return (
    <button
      ref={ref}
      type="button"
      className="hotbar-slot"
      data-item={slot.item}
      aria-pressed={pressed}
      aria-label={`Slot ${keyLabel}: ${slot.label}`}
      title={slot.label}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="hotbar-shape" style={shapeStyle(slot)} />
      <span className="hotbar-size">
        {footprint ? `${footprint.studsWide}×${footprint.studsDeep}` : ""}
      </span>
      <span className="hotbar-caption">{slot.caption}</span>
      <span className="hotbar-key">{keyLabel}</span>
    </button>
  );
}

function HotbarSlots({ snapshot, hotbar, slots }: HotbarSlotsProps) {
  const { keys } = commandSpec("pick-slot");
  return (
    <ol className="hotbar" aria-label="Hotbar">
      {slots.map((slot, index) => (
        <li key={slot.item}>
          <SlotButton
            slot={slot}
            keyLabel={keys[index]?.key ?? ""}
            pressed={snapshot.activeItem === slot.item}
            disabled={snapshot.readOnly}
            onPick={() => hotbar.pick(index)}
          />
        </li>
      ))}
    </ol>
  );
}

export function ToolHud({ snapshot, play, hotbar, hotbarShown }: ToolHudProps) {
  const view = toolHints(snapshot, play);
  const hotbarSnapshot = useHotbarSnapshot(hotbar);
  const slots = useMemo(
    () => hotbarView(hotbarSnapshot, snapshot.catalog, snapshot.roadKits),
    [hotbarSnapshot, snapshot.catalog, snapshot.roadKits],
  );
  const cued = useLateCue(view.waiting === null ? null : pendingSearch(snapshot));
  const detail = shownDetail(view, cued);
  const title = detail === null ? view.title : `${view.title} · ${detail}`;
  return (
    <>
      <div className="tool-hud" data-tone={view.tone}>
        {hotbarShown && slots.length > 0 && (
          <HotbarSlots snapshot={snapshot} hotbar={hotbar} slots={slots} />
        )}
        <div
          className="tool-status"
          role="status"
          aria-live={view.speech === null ? "polite" : "off"}
        >
          <span className="tool-title" title={title}>
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
        </div>
      </div>
      <PlacementSpeech speech={view.speech} busy={view.busy} />
    </>
  );
}
