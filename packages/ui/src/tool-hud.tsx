import {
  commandSpec,
  toolHints,
  type CatalogItemView,
  type EditorSnapshot,
  type Hotbar,
  type HudRegion,
  type ToolHint,
} from "@brr/client";
import { useRef, type CSSProperties } from "react";
import { Chord } from "./keys.tsx";
import { useHudRegion } from "./use-hud-region.ts";

interface ToolHudProps {
  readonly snapshot: EditorSnapshot;
  readonly hotbar: Hotbar;
  readonly onPickSlot: (slot: number) => void;
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

function hasFootprint(item: CatalogItemView | undefined): item is CatalogItemView {
  return item !== undefined && item.kind !== "track";
}

function footprintStyle(item: CatalogItemView | undefined, longest: number): CSSProperties {
  if (!hasFootprint(item)) return { width: SHAPE_PX, height: SHAPE_PX };
  const side = (studs: number) => Math.max(MIN_SHAPE_PX, Math.round((SHAPE_PX * studs) / longest));
  return {
    width: side(item.studsWide),
    height: side(item.studsDeep),
    ...(item.color ? { background: item.color.rgb } : {}),
  };
}

function sizeText(item: CatalogItemView | undefined): string {
  if (!hasFootprint(item)) return "track";
  return `${item.studsWide}×${item.studsDeep}`;
}

function bandStyle(region: HudRegion | null): CSSProperties | undefined {
  if (region === null) return undefined;
  return {
    left: region.left,
    top: region.top,
    width: region.right - region.left,
    height: region.bottom - region.top,
  };
}

function HotbarSlots({ snapshot, hotbar, onPickSlot }: ToolHudProps) {
  const { keys } = commandSpec("pick-slot");
  const items = hotbar.slots.map((id) => snapshot.catalog.find((entry) => entry.id === id));
  const longest = Math.max(
    1,
    ...items.filter(hasFootprint).map((item) => Math.max(item.studsWide, item.studsDeep)),
  );
  return (
    <ol className="hotbar" aria-label="Hotbar">
      {hotbar.slots.map((id, slot) => {
        const item = items[slot];
        const label = (item?.label ?? id).replaceAll("_", " ");
        return (
          <li key={id}>
            <button
              type="button"
              className="hotbar-slot"
              data-slot={slot + 1}
              data-item={id}
              aria-pressed={snapshot.activeItem === id}
              aria-label={`Slot ${keys[slot]?.key ?? ""}: ${label}`}
              title={label}
              onClick={() => onPickSlot(slot)}
            >
              <span
                className="hotbar-shape"
                data-kind={item?.kind ?? "track"}
                style={footprintStyle(item, longest)}
              />
              <span className="hotbar-size">{sizeText(item)}</span>
              <span className="hotbar-key">{keys[slot]?.key}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function ToolHud(props: ToolHudProps) {
  const view = toolHints(props.snapshot);
  const bandRef = useRef<HTMLDivElement>(null);
  const region = useHudRegion(bandRef);
  const title = view.detail === null ? view.title : `${view.title} · ${view.detail}`;
  return (
    <div ref={bandRef} className="tool-band" data-fits={region !== null} style={bandStyle(region)}>
      <div className="tool-hud" data-tone={view.tone}>
        {props.hotbar.slots.length > 0 && <HotbarSlots {...props} />}
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
    </div>
  );
}
