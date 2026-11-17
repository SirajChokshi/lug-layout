import type { EditorSnapshot, ICoach, StarterTileView, StarterView } from "@brr/client";
import { useEffect, useState } from "react";
import { useCoachSnapshot } from "./coach-overlay.tsx";

const PREVIEW_MARGIN_LDU = 80;
const TRACK_BED_LDU = 160;
const TRACK_TIES_LDU = 100;
const TILE_GAP_LDU = 6;

const LOADING_TIPS: ReadonlyArray<string> = [
  "Sorting baseplates by colour…",
  "Counting every stud…",
  "Checking that every loop closes exactly…",
  "Unpacking the station platforms…",
  "Polishing the 9V rails…",
];
const TIP_INTERVAL_MS = 1_800;

interface WelcomeProps {
  readonly coach: ICoach;
  readonly snapshot: EditorSnapshot;
}

function isEmptyWorld(snapshot: EditorSnapshot): boolean {
  return snapshot.placements === 0 && (snapshot.track?.pieces ?? 0) === 0;
}

function tileFill(tile: StarterTileView): string {
  switch (tile.kind) {
    case "ground":
    case "road":
      return tile.rgb ?? "#9aa4ad";
    case "module":
      return "#a7b0ba";
    case "set":
      return "#f3d38a";
    default: {
      const unhandled: never = tile.kind;
      throw new Error(`unhandled tile kind ${String(unhandled)}`);
    }
  }
}

function StarterMap({ starter }: { readonly starter: StarterView }) {
  const { bounds } = starter;
  const minX = bounds.minX - PREVIEW_MARGIN_LDU;
  const minZ = bounds.minZ - PREVIEW_MARGIN_LDU;
  const width = bounds.maxX - bounds.minX + 2 * PREVIEW_MARGIN_LDU;
  const depth = bounds.maxZ - bounds.minZ + 2 * PREVIEW_MARGIN_LDU;
  const order: ReadonlyArray<StarterTileView["kind"]> = ["ground", "road", "module", "set"];
  const tiles = order.flatMap((kind) => starter.tiles.filter((tile) => tile.kind === kind));
  return (
    <svg
      className="starter-map"
      viewBox={`${minX} ${minZ} ${width} ${depth}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Plan of ${starter.title}`}
    >
      {tiles.map((tile, index) => (
        <rect
          key={`${tile.item}-${index}`}
          className={`starter-tile starter-tile-${tile.kind}`}
          x={tile.rect.minX + TILE_GAP_LDU}
          y={tile.rect.minZ + TILE_GAP_LDU}
          width={tile.rect.maxX - tile.rect.minX - 2 * TILE_GAP_LDU}
          height={tile.rect.maxZ - tile.rect.minZ - 2 * TILE_GAP_LDU}
          fill={tileFill(tile)}
        >
          <title>{tile.label}</title>
        </rect>
      ))}
      {tiles.flatMap((tile, index) =>
        tile.roadRects.map((road, r) => (
          <rect
            key={`${tile.item}-${index}-road-${r}`}
            className="starter-road"
            x={road.minX}
            y={road.minZ}
            width={road.maxX - road.minX}
            height={road.maxZ - road.minZ}
          />
        )),
      )}
      {starter.trackPaths.map((path, index) => {
        const points = path.map(([x, z]) => `${x},${z}`).join(" ");
        return (
          <g key={index} className="starter-track">
            <polyline points={points} strokeWidth={TRACK_BED_LDU} className="starter-track-bed" />
            <polyline points={points} strokeWidth={TRACK_TIES_LDU} className="starter-track-ties" />
          </g>
        );
      })}
    </svg>
  );
}

function starterFacts(starter: StarterView): string {
  const facts: string[] = [`${starter.tiles.length} placements`];
  if (starter.trackPieces > 0) facts.push(`${starter.trackPieces} track pieces in a closed loop`);
  return facts.join(" · ");
}

function StarterCard({
  coach,
  starter,
}: {
  readonly coach: ICoach;
  readonly starter: StarterView;
}) {
  const unavailable = starter.problems.length > 0;
  return (
    <li className="starter-card" data-starter={starter.id}>
      <button
        type="button"
        className="starter-pick"
        disabled={unavailable}
        onClick={(event) => coach.loadStarter(starter.id, event.timeStamp)}
      >
        <StarterMap starter={starter} />
        <span className="starter-title">{starter.title}</span>
        <span className="starter-blurb">{starter.blurb}</span>
        <span className="starter-facts">{starterFacts(starter)}</span>
        {starter.sets.length > 0 && (
          <span className="starter-sets">With {starter.sets.join(", ")}</span>
        )}
        {unavailable && (
          <span className="starter-missing">Unavailable: {starter.problems.join("; ")}</span>
        )}
      </button>
    </li>
  );
}

function useRotatingTip(): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % LOADING_TIPS.length),
      TIP_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, []);
  return LOADING_TIPS[index] ?? "";
}

function LoadingCard() {
  const tip = useRotatingTip();
  return (
    <section className="welcome welcome-loading" aria-live="polite" aria-label="Loading">
      <div className="brick-stack" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>Setting up your table</h2>
      <p className="welcome-tip">{tip}</p>
    </section>
  );
}

export function WelcomePanel({ coach, snapshot }: WelcomeProps) {
  const [dismissed, setDismissed] = useState(false);
  const { tour } = useCoachSnapshot(coach);
  if (snapshot.status === "loading") return <LoadingCard />;
  if (snapshot.status !== "ready" || dismissed || tour.state === "running") return null;
  if (!isEmptyWorld(snapshot) || snapshot.mode !== "select") return null;
  return (
    <section className="welcome" aria-label="Start a layout">
      <h2>Your table is empty</h2>
      <p className="welcome-lede">
        Pick a starter layout built only from real parts, or start from scratch. Every track joint
        is exact, so the loops really close.
      </p>
      <ul className="starter-list">
        {snapshot.starters.map((starter) => (
          <StarterCard key={starter.id} coach={coach} starter={starter} />
        ))}
      </ul>
      <div className="welcome-actions">
        {tour.offered && (
          <button type="button" className="welcome-tour" onClick={() => coach.startTour()}>
            New here? Take the 1-minute tour
          </button>
        )}
        <button type="button" className="welcome-blank" onClick={() => setDismissed(true)}>
          Start from scratch
        </button>
        <span className="welcome-keys">
          <kbd>T</kbd> draws track · <kbd>R</kbd> rotates · right-drag orbits · wheel zooms
        </span>
      </div>
    </section>
  );
}
