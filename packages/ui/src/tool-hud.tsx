import {
  commandSpec,
  hotbarView,
  toolHints,
  type EditorSnapshot,
  type HotbarSlotView,
  type IHotbar,
  type PlaySnapshot,
  type ToolHint,
} from "@brr/client";
import { useEffect, useRef, type CSSProperties } from "react";
import { Chord } from "./keys.tsx";
import { useHotbarSnapshot } from "./use-hotbar.ts";

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly play: PlaySnapshot;
  readonly hotbar: IHotbar;
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
  return hint.kind === "key" ? hint.command : hint.gesture;
}

function HintInput({ hint }: { readonly hint: ToolHint }) {
  if (hint.kind === "gesture") return <span className="tool-gesture">{hint.gesture}</span>;
  const [chord] = commandSpec(hint.command).keys;
  return chord ? <Chord chord={chord} /> : null;
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

export function ToolHud({ snapshot, play, hotbar }: ToolHudProps) {
  const view = toolHints(snapshot, play);
  const slots = hotbarView(useHotbarSnapshot(hotbar), snapshot.catalog);
  const title = view.detail === null ? view.title : `${view.title} · ${view.detail}`;
  return (
    <div className="tool-hud" data-tone={view.tone}>
      {slots.length > 0 && <HotbarSlots snapshot={snapshot} hotbar={hotbar} slots={slots} />}
      <div className="tool-status" role="status" aria-live="polite">
        <span className="tool-title" title={title}>
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
    </div>
  );
}
