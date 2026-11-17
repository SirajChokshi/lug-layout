import { useState, type ReactNode } from "react";
import {
  TRACK_ITEM_ID,
  TRACK_PIECE_PREFIX,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface PaletteProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

interface ItemGroup {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<CatalogItemView>;
}

function groupsOf(
  items: ReadonlyArray<CatalogItemView>,
  kind: CatalogItemView["kind"],
): ReadonlyArray<ItemGroup> {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    if (item.kind !== kind) continue;
    const group = groups.get(item.group) ?? { key: item.group, label: item.groupLabel, items: [] };
    groups.set(item.group, { ...group, items: [...group.items, item] });
  }
  return [...groups.values()];
}

function size(item: CatalogItemView): string {
  return `${item.studsWide}×${item.studsDeep}`;
}

function matches(query: string, group: ItemGroup): boolean {
  if (query === "") return true;
  const haystack = [group.label, ...group.items.map((item) => `${item.label} ${size(item)}`)]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .every((word) => haystack.includes(word));
}

function Section({
  id,
  title,
  count,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="palette-section" data-section={id} open>
      <summary>
        <span>{title}</span>
        <span className="palette-count">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function Swatches({ group, editor, snapshot }: PaletteProps & { readonly group: ItemGroup }) {
  const first = group.items[0];
  if (!first) return null;
  return (
    <li className="palette-row" data-group={group.key}>
      <div className="palette-row-label">
        <span className="palette-size">{size(first)}</span>
        <span className="palette-title">{group.label}</span>
      </div>
      <div className="palette-swatches" role="group" aria-label={group.label}>
        {group.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="palette-swatch"
            data-item={item.id}
            aria-pressed={snapshot.activeItem === item.id}
            aria-label={item.label}
            title={item.color?.name ?? item.label}
            style={{ background: item.color?.rgb ?? "transparent" }}
            onClick={() => editor.chooseItem(item.id)}
          />
        ))}
      </div>
    </li>
  );
}

function ItemButton({ item, editor, snapshot }: PaletteProps & { readonly item: CatalogItemView }) {
  return (
    <li>
      <button
        type="button"
        className="catalog-item"
        data-item={item.id}
        aria-pressed={snapshot.activeItem === item.id}
        onClick={() => editor.chooseItem(item.id)}
      >
        <span className="catalog-name">{item.label}</span>
        <span className="catalog-meta">
          {integer.format(item.parts)} {item.parts === 1 ? "part" : "parts"} · {size(item)} studs
        </span>
      </button>
    </li>
  );
}

function colorCount(groups: ReadonlyArray<ItemGroup>): string {
  const items = groups.reduce((sum, group) => sum + group.items.length, 0);
  return `${groups.length} ${groups.length === 1 ? "part" : "parts"}, ${items} colours`;
}

function TrackSection({ editor, snapshot }: PaletteProps) {
  const drawing = snapshot.mode === "track" && snapshot.activeItem === TRACK_ITEM_ID;
  const pieces = snapshot.catalog.filter((item) => item.id.startsWith(TRACK_PIECE_PREFIX));
  const available = snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
  const held = snapshot.track?.held ?? null;
  return (
    <Section id="track" title="Track" count={`${pieces.length} real pieces`}>
      <button
        type="button"
        className="palette-primary"
        data-item={TRACK_ITEM_ID}
        aria-pressed={drawing}
        disabled={!available}
        onClick={() => editor.chooseItem(drawing ? null : TRACK_ITEM_ID)}
      >
        {drawing ? "Drawing track: press Esc or T to stop" : "Draw track (T)"}
      </button>
      <p className="palette-hint">
        Drag on the ground to lay a run of real pieces. Start on an open end to continue a line, and
        release on another open end to join it exactly.
      </p>
      <ul className="palette-pieces" aria-label="Single track pieces">
        {pieces.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="catalog-item"
              data-item={item.id}
              aria-pressed={
                snapshot.activeItem === item.id ||
                (held !== null && item.id === `${TRACK_PIECE_PREFIX}${held.item}`)
              }
              onClick={() => editor.chooseItem(snapshot.activeItem === item.id ? null : item.id)}
            >
              <span className="catalog-name">{item.label}</span>
              <span className="catalog-meta">{size(item)} studs</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="palette-hint">
        Pick a piece, then click to lay it. Near an open end it attaches exactly. Q swings it onto
        its next end, R turns it 22.5° on open ground, X swaps a switch between left and right.
        Click a laid switch to throw it.
      </p>
      {snapshot.trackNotDrawable.length > 0 && (
        <p className="palette-note" data-not-drawable={snapshot.trackNotDrawable.length}>
          In the bundle but not drawable yet:{" "}
          {snapshot.trackNotDrawable.map((part) => `${part.id} ${part.title}`).join("; ")}.
        </p>
      )}
    </Section>
  );
}

function SwatchSection({
  id,
  title,
  groups,
  editor,
  snapshot,
  children,
}: PaletteProps & {
  readonly id: string;
  readonly title: string;
  readonly groups: ReadonlyArray<ItemGroup>;
  readonly children?: ReactNode;
}) {
  return (
    <Section id={id} title={title} count={colorCount(groups)}>
      {children}
      <ul className="palette-rows">
        {groups.map((group) => (
          <Swatches key={group.key} group={group} editor={editor} snapshot={snapshot} />
        ))}
      </ul>
    </Section>
  );
}

function MilsSection({
  groups,
  editor,
  snapshot,
}: PaletteProps & { readonly groups: ReadonlyArray<ItemGroup> }) {
  return (
    <Section id="mils" title="MILS modules" count={`${groups.length} modules`}>
      <ul>
        {groups.flatMap((group) =>
          group.items.map((item) => (
            <ItemButton key={item.id} item={item} editor={editor} snapshot={snapshot} />
          )),
        )}
      </ul>
      <p className="palette-note" data-mils-flag="heights">
        The plain module's surface is 4 plates above the baseplate (the MILS reference height). The
        road modules carry MultiRoad streets at 6 plates and walkways at 8, so they don't sit flush
        against plain modules without a transition.
      </p>
      <p className="palette-note" data-mils-flag="track">
        No track module: MILS has no train rules (HispaBrick Magazine 026, "MILS (VII)"). To run
        track, lay it with Draw track.
      </p>
      <p className="palette-note" data-mils-flag="corner">
        No corner module beyond the road curve: MILS only says that a road or river curve is a 90°
        element (HispaBrick Magazine 016, "MILS (IV)").
      </p>
    </Section>
  );
}

export function PalettePanel({ editor, snapshot }: PaletteProps) {
  const [query, setQuery] = useState("");
  const pick = (kind: CatalogItemView["kind"]) =>
    groupsOf(snapshot.catalog, kind).filter((group) => matches(query, group));
  const baseplates = pick("baseplate");
  const roads = pick("road-plate");
  const modules = pick("mils-module");
  const models = pick("model");
  const shown = (groups: ReadonlyArray<ItemGroup>) => query === "" || groups.length > 0;
  return (
    <nav className="catalog palette" aria-label="Palette">
      <h2>Palette</h2>
      <input
        type="search"
        className="palette-search"
        placeholder="Filter: green, 16×16, crossroads, curve…"
        aria-label="Filter the palette"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <TrackSection editor={editor} snapshot={snapshot} />
      {shown(baseplates) && (
        <SwatchSection
          id="baseplates"
          title="Baseplates"
          groups={baseplates}
          editor={editor}
          snapshot={snapshot}
        />
      )}
      {shown(modules) && <MilsSection groups={modules} editor={editor} snapshot={snapshot} />}
      {shown(roads) && (
        <SwatchSection id="road" title="Road" groups={roads} editor={editor} snapshot={snapshot} />
      )}
      {shown(models) && (
        <Section id="sets" title="Sets" count={`${models.length} sets`}>
          <ul>
            {models.flatMap((group) =>
              group.items.map((item) => (
                <ItemButton key={item.id} item={item} editor={editor} snapshot={snapshot} />
              )),
            )}
          </ul>
        </Section>
      )}
      {query !== "" &&
        [baseplates, modules, roads, models].every((groups) => groups.length === 0) && (
          <p className="palette-hint">Nothing matches “{query}”.</p>
        )}
      {snapshot.catalogSkipped.length > 0 && (
        <p
          className="catalog-skipped"
          data-catalog-skipped={snapshot.catalogSkipped.map((model) => model.name).join(",")}
        >
          Not placeable: {skippedText(snapshot)}
        </p>
      )}
    </nav>
  );
}

function skippedText(snapshot: EditorSnapshot): string {
  const byReason = new Map<string, string[]>();
  for (const model of snapshot.catalogSkipped) {
    byReason.set(model.reason, [...(byReason.get(model.reason) ?? []), model.name]);
  }
  return [...byReason].map(([reason, names]) => `${names.join(", ")} (${reason})`).join("; ");
}
