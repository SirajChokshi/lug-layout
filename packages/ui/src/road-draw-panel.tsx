import type {
  EditorSnapshot,
  IEditor,
  RoadKitView,
  RoadShape,
  RoadStrokeView,
  RoadTileIssue,
} from "@brr/client";

const SHAPES: ReadonlyArray<RoadShape> = ["straight", "curve", "t-junction", "crossroads"];

export function shapeName(shape: RoadShape): string {
  switch (shape) {
    case "dead-end":
      return "dead end";
    case "straight":
      return "straight";
    case "curve":
      return "curve";
    case "t-junction":
      return "T-junction";
    case "crossroads":
      return "crossroads";
    default: {
      const unhandled: never = shape;
      throw new Error(`unhandled road shape ${String(unhandled)}`);
    }
  }
}

function issueText(issue: RoadTileIssue): string {
  const where = `at ${issue.x}, ${issue.z}`;
  switch (issue.problem) {
    case "no-piece":
      return `${where}: needs a ${issue.shape ? shapeName(issue.shape) : "piece"}, and this kit has none`;
    case "other-family":
      return `${where}: a plate from another road family is there, so it can't become a ${issue.shape ? shapeName(issue.shape) : "different piece"}`;
    case "mismatch":
      return `${where}: its edges wouldn't line up with ${issue.blocker ?? "the road"} beside it`;
    case "overlap":
      return `${where}: overlaps ${issue.blocker ?? "another plate"}`;
    default: {
      const unhandled: never = issue.problem;
      throw new Error(`unhandled road problem ${String(unhandled)}`);
    }
  }
}

function strokeText(stroke: RoadStrokeView): string {
  const parts: string[] = [];
  if (stroke.laid > 0) parts.push(`${stroke.laid} new`);
  if (stroke.replaced > 0) parts.push(`${stroke.replaced} upgraded`);
  if (stroke.overGround > 0) parts.push(`${stroke.overGround} swapped for ground under them`);
  if (stroke.kept > 0) parts.push(`${stroke.kept} already right`);
  const changes = parts.length > 0 ? parts.join(", ") : "nothing to change";
  return `${stroke.tiles} ${stroke.tiles === 1 ? "tile" : "tiles"}: ${changes}`;
}

function itemShortName(item: string): string {
  return item.replace(/^[a-z]+:/u, "").replace(/@\d+$/u, "");
}

interface KitsProps {
  readonly editor: IEditor;
  readonly snapshot: Pick<EditorSnapshot, "mode" | "roadKit" | "readOnly">;
  readonly kits: ReadonlyArray<RoadKitView>;
}

export function RoadKitList({ editor, snapshot, kits }: KitsProps) {
  const drawing = snapshot.mode === "road";
  return (
    <div className="road-kits" data-road-kits={kits.length}>
      <button
        type="button"
        className="palette-primary"
        data-action="draw-road"
        aria-pressed={drawing}
        disabled={snapshot.roadKit === null || snapshot.readOnly}
        onClick={() => editor.chooseItem(drawing ? null : snapshot.roadKit)}
      >
        {drawing ? "Drawing road: press Esc or G to stop" : "Draw road (G)"}
      </button>
      <p className="palette-hint">
        Drag across the ground. Each tile gets the real straight, curve, T-junction or crossroads
        its neighbours need, and branching off a road upgrades the plate there. A plain baseplate
        exactly under a tile is swapped for the road piece. R turns a lone tile.
      </p>
      <ul className="road-kit-list">
        {kits.map((kit) => (
          <li key={kit.id}>
            <button
              type="button"
              className="road-kit"
              data-kit={kit.id}
              aria-pressed={snapshot.roadKit === kit.id && drawing}
              disabled={snapshot.readOnly}
              onClick={() => editor.chooseItem(kit.id)}
            >
              <span className="road-kit-name">{kit.label}</span>
              <span className="road-kit-meta">
                {kit.tileStuds}×{kit.tileStuds} tiles, edge {kit.edge} studs ·{" "}
                {kit.pieces.map((piece) => itemShortName(piece.item)).join(", ")}
              </span>
              <span className="road-kit-shapes">
                {SHAPES.map((shape) => (
                  <span
                    key={shape}
                    className={kit.shapes.includes(shape) ? "road-shape has" : "road-shape missing"}
                  >
                    {shapeName(shape)}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function releaseText(snapshot: EditorSnapshot): string {
  const last = snapshot.lastRoadStroke;
  if (!last) return "none yet";
  const red = last.stroke.issues.length;
  return last.result === "laid"
    ? `laid ${strokeText(last.stroke)}`
    : `refused, ${red} red ${red === 1 ? "tile" : "tiles"}; nothing laid`;
}

export function RoadDrawPanel({ snapshot }: { readonly snapshot: EditorSnapshot }) {
  if (snapshot.mode !== "road") return null;
  const stroke = snapshot.roadStroke;
  const kit = snapshot.roadKits.find((k) => k.id === snapshot.roadKit);
  const last = snapshot.lastRoadStroke;
  const issues = stroke?.issues.length
    ? stroke.issues
    : last?.result === "refused"
      ? last.stroke.issues
      : [];
  return (
    <section
      className="inspector road-draw-panel"
      aria-label="Road drawing"
      data-road-tiles={stroke?.tiles ?? 0}
      data-road-laid={stroke?.laid ?? 0}
      data-road-replaced={stroke?.replaced ?? 0}
      data-road-issues={stroke?.issues.length ?? 0}
      data-road-last={last?.result ?? ""}
    >
      <h2>Draw road</h2>
      <dl>
        <div>
          <dt>Kit</dt>
          <dd>{kit ? `${kit.label}, edge ${kit.edge} studs` : "none"}</dd>
        </div>
        <div>
          <dt>Preview</dt>
          <dd>
            {stroke ? strokeText(stroke) : "move over the ground"}
            {stroke && stroke.issues.length > 0 ? ", release lays nothing" : ""}
          </dd>
        </div>
        <div>
          <dt>Last release</dt>
          <dd>{releaseText(snapshot)}</dd>
        </div>
      </dl>
      {issues.length > 0 && (
        <ul className="road-issues">
          {issues.map((issue) => (
            <li key={`${issue.x},${issue.z}`} className="mismatch">
              {issueText(issue)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
