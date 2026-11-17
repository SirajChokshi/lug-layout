import { useState, type ReactNode } from "react";
import {
  TRACK_ITEM_ID,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
} from "@brr/client";
import { RoadKitList } from "./road-draw-panel.tsx";

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
  const drawing = snapshot.mode === "track";
  const kit = snapshot.track?.bom ?? [];
  const available = snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
  return (
    <Section id="track" title="Track" count={`${kit.length} drawable pieces`}>
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
      {kit.length > 0 && (
        <ul className="palette-parts">
          {kit.map((line) => (
            <li key={line.piece}>
              <span className="palette-size">{line.piece.replace(/^[a-z]+:/u, "")}</span>
              {line.title}
            </li>
          ))}
        </ul>
      )}
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
        Every module follows MILS (HispaBrick Magazine 013–016): a 32×32 module with its surface 4
        plates above the baseplate, and a 2×2 corner then a 1×4 Technic brick at each end of every
        side. Paths (4 studs) and earth tracks (8 studs) sit at the surface, paved roads (16 studs)
        one plate above it, and rivers (8 studs) at 2 plates with banks rising a plate per stud.
        Each feature is centred on the edges it crosses, and curves are single 90° elements.
      </p>
      <p className="palette-note" data-mils-flag="track">
        The rail module is a project rule, not MILS: MILS has no train rules (HispaBrick Magazine
        026, "MILS (VII)"). It centres one pair of 9V straights on the 4-plate surface.
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
        <SwatchSection id="road" title="Road" groups={roads} editor={editor} snapshot={snapshot}>
          <RoadKitList editor={editor} snapshot={snapshot} kits={snapshot.roadKits} />
        </SwatchSection>
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
