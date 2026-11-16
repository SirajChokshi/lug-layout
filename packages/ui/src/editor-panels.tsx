import type {
  CatalogItemView,
  EditorCredits,
  EditorSnapshot,
  IEditor,
  LatencySample,
} from "@brr/client";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEGREES_PER_QUARTER_TURN = 90;

function degrees(rot: number): string {
  return `${rot * DEGREES_PER_QUARTER_TURN}°`;
}

function itemLabel(snapshot: EditorSnapshot, id: string | null): string {
  if (id === null) return "none";
  return snapshot.catalog.find((item) => item.id === id)?.label ?? id;
}

interface PanelProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

function CatalogEntry({
  item,
  active,
  onChoose,
}: {
  readonly item: CatalogItemView;
  readonly active: boolean;
  readonly onChoose: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={active ? "catalog-item active" : "catalog-item"}
        data-item={item.id}
        aria-pressed={active}
        onClick={() => onChoose(item.id)}
      >
        <span className="catalog-name">{item.label}</span>
        <span className="catalog-meta">
          {integer.format(item.parts)} {item.parts === 1 ? "part" : "parts"} · {item.studsWide}×
          {item.studsDeep} studs
        </span>
      </button>
    </li>
  );
}

export function CatalogList({ editor, snapshot }: PanelProps) {
  return (
    <nav className="catalog" aria-label="Catalog">
      <h2>Catalog</h2>
      <ul>
        {snapshot.catalog.map((item) => (
          <CatalogEntry
            key={item.id}
            item={item}
            active={snapshot.activeItem === item.id}
            onChoose={(id) => editor.chooseItem(id)}
          />
        ))}
      </ul>
    </nav>
  );
}

export function PlacementToolbar({ editor, snapshot }: PanelProps) {
  const canRotate = snapshot.mode === "place" || snapshot.selection !== null;
  return (
    <div className="toolbar" role="toolbar" aria-label="Placement tools">
      <button
        type="button"
        aria-pressed={snapshot.mode === "select"}
        onClick={() => editor.chooseItem(null)}
      >
        Select (Esc)
      </button>
      <button
        type="button"
        disabled={!canRotate}
        onClick={(event) => editor.rotate(event.timeStamp)}
      >
        Rotate 90° (R)
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={(event) => editor.deleteSelection(event.timeStamp)}
      >
        Delete (Del)
      </button>
      <button
        type="button"
        disabled={snapshot.selection === null}
        onClick={() => editor.focusSelection()}
      >
        Focus (F)
      </button>
      <p className="toolbar-hint">
        Right-drag orbits, Shift-drag pans, the wheel zooms, C centres on the cursor.
      </p>
    </div>
  );
}

export function Inspector({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { selection } = snapshot;
  return (
    <section className="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      {selection ? (
        <dl>
          <div>
            <dt>Model</dt>
            <dd>{itemLabel(snapshot, selection.item)}</dd>
          </div>
          <div>
            <dt>x, z (LDU)</dt>
            <dd>
              {selection.x}, {selection.z}
            </dd>
          </div>
          <div>
            <dt>Height (plates)</dt>
            <dd>{selection.yPlates}</dd>
          </div>
          <div>
            <dt>Rotation</dt>
            <dd>{degrees(selection.rot)}</dd>
          </div>
          <div>
            <dt>Footprint x, z (LDU)</dt>
            <dd>
              {selection.box.minX}…{selection.box.maxX}, {selection.box.minZ}…{selection.box.maxZ}
            </dd>
          </div>
          <div>
            <dt>Chunk key, slot</dt>
            <dd>
              {selection.chunkKey}, {selection.slot}
            </dd>
          </div>
        </dl>
      ) : (
        <p>Nothing selected. Click a placed model.</p>
      )}
    </section>
  );
}

function latencyText(sample: LatencySample | null, snapshot: EditorSnapshot): string {
  if (!sample) return "none yet";
  return `${sample.ms.toFixed(1)} ms (${sample.action} ${itemLabel(snapshot, sample.item)}, ${degrees(sample.rot)})`;
}

function rebuildText(sample: LatencySample | null): string {
  if (!sample) return "none yet";
  return `${sample.rebuiltChunks} chunks, ${integer.format(sample.rebuiltInstances)} parts, ${integer.format(sample.rebuiltStuds)} studs`;
}

export function EditorHud({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  const { backend, stats } = snapshot;
  const rows: Array<readonly [string, string]> = [];
  if (backend) {
    rows.push(
      [
        "API",
        backend.activeApi === backend.requestedApi
          ? backend.activeApi
          : `${backend.activeApi} (asked ${backend.requestedApi})`,
      ],
      ["Adapter", backend.adapter],
    );
  }
  if (snapshot.loadMs !== null) rows.push(["Load", `${integer.format(snapshot.loadMs)} ms`]);
  rows.push(
    [
      "Mode",
      snapshot.mode === "place" ? `place ${itemLabel(snapshot, snapshot.activeItem)}` : "select",
    ],
    ["Ghost rotation", degrees(snapshot.ghostRot)],
    [
      "Cursor on lattice (LDU)",
      snapshot.hover ? `${snapshot.hover.x}, ${snapshot.hover.z}` : "off the ground",
    ],
    ["Placements", integer.format(snapshot.placements)],
    ["Last placement latency", latencyText(snapshot.lastLatency, snapshot)],
    ["Rebuilt for it", rebuildText(snapshot.lastLatency)],
  );
  if (stats) {
    rows.push(
      ["Frame rate (rAF)", `${stats.fps.toFixed(1)} fps`],
      ["Draw calls", integer.format(stats.drawCalls)],
      ["Drawn triangles", integer.format(stats.triangles)],
    );
  }
  return (
    <aside className="hud editor-hud">
      <h1>Brick Railroad</h1>
      {snapshot.status === "loading" && <p>Loading the bundle and the 10 sets…</p>}
      {snapshot.error !== null && <p className="error">{snapshot.error}</p>}
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function modelCredits(credits: EditorCredits): string {
  return credits.models
    .map((model) => {
      const authors = [...new Set(model.sections.map((s) => s.author).filter((a) => a !== ""))];
      const licenses = [...new Set(model.sections.flatMap((s) => (s.license ? [s.license] : [])))];
      return `${model.name}${authors.length > 0 ? ` by ${authors.join(", ")}` : ""}${licenses.length > 0 ? ` (${licenses.join("; ")})` : ""}`;
    })
    .join("; ");
}

export function CreditsFooter({
  snapshot,
  disclaimer,
}: {
  readonly snapshot: EditorSnapshot;
  readonly disclaimer: string;
}) {
  const { credits } = snapshot;
  return (
    <footer>
      {credits &&
        `Models from the LDraw Official Model Repository: ${modelCredits(credits)}. Parts: LDraw parts library, ${credits.partFiles} files (${credits.partLicenses.join(", ")}), modified from LDraw: flattened, studs extracted. Colours: LDraw LDConfig.ldr. `}
      {disclaimer}
    </footer>
  );
}
