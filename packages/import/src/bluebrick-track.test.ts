import { connectorPose } from "@brr/domain";
import {
  QUARTER_TURN_16,
  isLatticePose16,
  pose16,
  posesJoin16,
  zeta16,
  type Pose16,
} from "@brr/math";
import type { BlueBrickBrick, BlueBrickConnectionRef, BlueBrickMap } from "@brr/schema/bluebrick";
import type { TrackCatalog } from "@brr/schema/bundle";
import { expect, it } from "vitest";
import type { BlueBrickIdMapping } from "./bluebrick-mapping.ts";
import {
  relayBlueBrickTrack,
  type BlueBrickTrack,
  type BlueBrickTrackPiece,
} from "./bluebrick-track.ts";
import { BUNDLE_TIMEOUT_MS, blueBrickBundle, readFixture } from "./bluebrick.test-support.ts";

const TRACK_LAYER = 1;
const NINE_VOLT_IDS = { "2865.8": "74746", "2867.8": "74747" };
const STEP_DEGREES = 22.5;
const DRAWN_WITHIN_STUDS = 1;
const SYNTHETIC_NOISE_STUDS = 0.25 * Math.SQRT2;
const STRAIGHT_STUDS = 16;
const ALTITUDE = { kind: "altitude", brick: { layer: TRACK_LAYER, brick: 30 }, altitude: "3" };

interface Ref {
  readonly layer: number;
  readonly brick: number;
}

function refKey({ layer, brick }: Ref): string {
  return `${layer}:${brick}`;
}

function at(xStuds: number, zStuds: number, heading: number): Pose16 {
  return pose16(zeta16([BigInt(xStuds), 0n, 0n, 0n, BigInt(zStuds), 0n, 0n, 0n]), heading);
}

function connection(layer: number, brick: number, index: number): BlueBrickConnectionRef {
  return { layer, brick, connection: index };
}

function partMapping(parts: Readonly<Record<string, string>>): ReadonlyArray<BlueBrickIdMapping> {
  return Object.entries(parts).map(([id, part]) => ({
    id,
    bricks: 0,
    groups: 0,
    outcome: { kind: "part", part, color: 0, via: "ldraw", redirects: [] },
  }));
}

function laid(track: BlueBrickTrack): ReadonlyMap<string, BlueBrickTrackPiece> {
  return new Map(
    track.components
      .flatMap((component) => component.pieces)
      .map((piece) => [refKey(piece.brick), piece]),
  );
}

function links(
  map: BlueBrickMap,
): ReadonlyArray<readonly [BlueBrickConnectionRef, BlueBrickConnectionRef]> {
  return map.layers.flatMap((layer, l) =>
    layer.kind !== "brick"
      ? []
      : layer.bricks.flatMap((brick, b) =>
          brick.connections.flatMap(({ link }, c) => {
            const from = connection(l, b, c);
            const later = link && (link.layer - l || link.brick - b || link.connection - c) > 0;
            return link && later ? [[from, link] as const] : [];
          }),
        ),
  );
}

function unjoinedLinks(
  map: BlueBrickMap,
  track: BlueBrickTrack,
  catalog: TrackCatalog,
): ReadonlyArray<BlueBrickConnectionRef> {
  const pieces = laid(track);
  const ends = ({ catalogIndex, placement }: BlueBrickTrackPiece): ReadonlyArray<Pose16> => {
    const piece = catalog.pieces[catalogIndex];
    const def = { id: piece?.id ?? "", connectors: piece?.connectors.map((c) => c.pose) ?? [] };
    return def.connectors.map((_, end) => connectorPose({ piece: def, placement }, end));
  };
  return links(map).flatMap(([from, to]) => {
    const a = pieces.get(refKey(from));
    const b = pieces.get(refKey(to));
    if (!a || !b) return [];
    const theirs = ends(b);
    return ends(a).some((end) => theirs.some((other) => posesJoin16(end, other))) ? [] : [from];
  });
}

function linkedGroups(
  map: BlueBrickMap,
  keys: ReadonlySet<string>,
): ReadonlyArray<ReadonlySet<string>> {
  const parent = new Map([...keys].map((key) => [key, key]));
  const root = (key: string): string => {
    const up = parent.get(key) ?? key;
    return up === key ? key : root(up);
  };
  for (const [from, to] of links(map)) {
    if (keys.has(refKey(from)) && keys.has(refKey(to)))
      parent.set(root(refKey(from)), root(refKey(to)));
  }
  const groups = new Map<string, Set<string>>();
  for (const key of keys) groups.set(root(key), (groups.get(root(key)) ?? new Set()).add(key));
  return [...groups.values()];
}

function canonical(groups: ReadonlyArray<Iterable<string>>): ReadonlyArray<ReadonlyArray<string>> {
  return groups
    .map((group) => [...group].toSorted())
    .toSorted((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
}

function withTrackBricks(
  map: BlueBrickMap,
  change: (bricks: ReadonlyArray<BlueBrickBrick>) => ReadonlyArray<BlueBrickBrick>,
): BlueBrickMap {
  return {
    ...map,
    layers: map.layers.map((layer, l) =>
      l === TRACK_LAYER && layer.kind === "brick"
        ? { ...layer, bricks: change(layer.bricks) }
        : layer,
    ),
  };
}

function drawnLike(moved: number, onto: number) {
  return (bricks: ReadonlyArray<BlueBrickBrick>): ReadonlyArray<BlueBrickBrick> => {
    const like = bricks[onto];
    return bricks.map((brick, b) =>
      b === moved && like ? { ...brick, area: like.area, orientation: like.orientation } : brick,
    );
  };
}

function relinked(
  rewired: ReadonlyArray<readonly [BlueBrickConnectionRef, BlueBrickConnectionRef | null]>,
) {
  const targets = new Map(rewired.map(([from, to]) => [`${refKey(from)}:${from.connection}`, to]));
  return (bricks: ReadonlyArray<BlueBrickBrick>): ReadonlyArray<BlueBrickBrick> =>
    bricks.map((brick, b) => ({
      ...brick,
      connections: brick.connections.map((entry, c) => {
        const key = `${TRACK_LAYER}:${b}:${c}`;
        return targets.has(key) ? { ...entry, link: targets.get(key) ?? null } : entry;
      }),
    }));
}

it.each(["sample_track01.bbm", "queue.bbm"])(
  "re-lays the 9V track of %s, a real BlueBrick layout, so every linked pair joins exactly and only runs drawn off the 22.5 degree steps turn",
  async (file) => {
    const { compiler, track: bundle } = await blueBrickBundle();
    const map = await readFixture(compiler, file);
    const relaid = relayBlueBrickTrack(map, partMapping(NINE_VOLT_IDS), bundle);
    const drawn = new Map(
      map.layers.flatMap((layer, l) =>
        layer.kind !== "brick"
          ? []
          : layer.bricks.flatMap((brick, b) =>
              Object.hasOwn(NINE_VOLT_IDS, brick.part)
                ? [[refKey({ layer: l, brick: b }), brick] as const]
                : [],
            ),
      ),
    );
    expect(new Set(laid(relaid).keys())).toEqual(new Set(drawn.keys()));
    expect(
      canonical(
        relaid.components.map((component) => component.pieces.map((piece) => refKey(piece.brick))),
      ),
    ).toEqual(canonical(linkedGroups(map, new Set(drawn.keys()))));
    expect(relaid.issues).toEqual([]);
    expect(unjoinedLinks(map, relaid, bundle.trackCatalog)).toEqual([]);
    for (const component of relaid.components) {
      const offStep = component.pieces.filter(
        (piece) => Number(drawn.get(refKey(piece.brick))?.orientation) % STEP_DEGREES !== 0,
      ).length;
      const drawnWithin = offStep > 0 || component.shiftStuds <= DRAWN_WITHIN_STUDS;
      expect({ turn: Math.abs(component.turnDegrees), offStep, drawnWithin }).toEqual(
        offStep === 0
          ? { turn: 0, offStep, drawnWithin: true }
          : { turn: STEP_DEGREES / 2, offStep: component.pieces.length, drawnWithin: true },
      );
    }
    const straight = bundle.trackCatalog.pieces.findIndex((piece) => piece.part === "ldraw:74746");
    const quarterTurnedStraights = [...laid(relaid).values()].filter(
      (piece) => piece.catalogIndex === straight && piece.placement.heading % QUARTER_TURN_16 === 0,
    );
    expect(quarterTurnedStraights.length).toBeGreaterThan(0);
    expect(quarterTurnedStraights.filter((piece) => !isLatticePose16(piece.placement))).toEqual([]);
  },
  BUNDLE_TIMEOUT_MS,
);

it(
  "re-lays a synthetic layout of official track exactly where it was drawn: a closed oval, a crossing, a run turned 22.5 degrees and a raised curve",
  async () => {
    const { compiler, mapper, track: bundle } = await blueBrickBundle();
    const map = await readFixture(compiler, "synthetic-loops.bbm");
    const relaid = relayBlueBrickTrack(map, await mapper.map(map), bundle);
    expect(
      relaid.components.map((component) => ({
        anchor: component.pieces[0]?.brick,
        placement: component.pieces[0]?.placement,
        pieces: component.pieces.length,
        turnDegrees: component.turnDegrees,
      })),
    ).toEqual([
      {
        anchor: { layer: TRACK_LAYER, brick: 0 },
        placement: at(0, 0, 0),
        pieces: 20,
        turnDegrees: 0,
      },
      {
        anchor: { layer: TRACK_LAYER, brick: 20 },
        placement: at(96, 24, 0),
        pieces: 5,
        turnDegrees: 0,
      },
      {
        anchor: { layer: TRACK_LAYER, brick: 25 },
        placement: at(24, 104, 1),
        pieces: 5,
        turnDegrees: 0,
      },
      {
        anchor: { layer: TRACK_LAYER, brick: 30 },
        placement: at(120, 96, 2),
        pieces: 1,
        turnDegrees: 0,
      },
    ]);
    expect(relaid.issues).toEqual([ALTITUDE]);
    expect(unjoinedLinks(map, relaid, bundle.trackCatalog)).toEqual([]);
    for (const component of relaid.components) {
      expect(component.shiftStuds).toBeLessThanOrEqual(SYNTHETIC_NOISE_STUDS);
    }
  },
  BUNDLE_TIMEOUT_MS,
);

it.each([
  {
    change: "a curve of the oval drawn facing the other way",
    edit: (bricks: ReadonlyArray<BlueBrickBrick>) =>
      bricks.map((brick, b) =>
        b === 5 ? { ...brick, orientation: String(Number(brick.orientation) + 180) } : brick,
      ),
    issues: [
      { kind: "unpaired", from: connection(TRACK_LAYER, 4, 1), to: connection(TRACK_LAYER, 5, 0) },
      { kind: "unpaired", from: connection(TRACK_LAYER, 5, 1), to: connection(TRACK_LAYER, 6, 0) },
    ],
  },
  {
    change: "a straight drawn on top of the straight it links to",
    edit: drawnLike(26, 25),
    issues: [
      {
        kind: "ambiguous",
        from: connection(TRACK_LAYER, 25, 1),
        to: connection(TRACK_LAYER, 26, 0),
      },
    ],
  },
  {
    change: "two arms of the crossing drawn on the same end",
    edit: drawnLike(23, 21),
    issues: [
      {
        kind: "ambiguous",
        from: connection(TRACK_LAYER, 20, 0),
        to: connection(TRACK_LAYER, 23, 0),
      },
      {
        kind: "ambiguous",
        from: connection(TRACK_LAYER, 20, 1),
        to: connection(TRACK_LAYER, 21, 0),
      },
    ],
  },
  {
    change: "a link that skips a straight of the closed oval",
    edit: relinked([
      [connection(TRACK_LAYER, 0, 1), connection(TRACK_LAYER, 2, 0)],
      [connection(TRACK_LAYER, 2, 0), connection(TRACK_LAYER, 0, 1)],
      [connection(TRACK_LAYER, 1, 0), null],
      [connection(TRACK_LAYER, 1, 1), null],
    ]),
    issues: [
      {
        kind: "notClosing",
        from: expect.objectContaining({ layer: TRACK_LAYER }),
        to: expect.objectContaining({ layer: TRACK_LAYER }),
        gapStuds: expect.closeTo(STRAIGHT_STUDS, 9),
      },
    ],
  },
])(
  "reports the links it can't join and joins every other link exactly when the file has $change",
  async ({ edit, issues }) => {
    const { compiler, mapper, track: bundle } = await blueBrickBundle();
    const drawn = await readFixture(compiler, "synthetic-loops.bbm");
    const map = withTrackBricks(drawn, edit);
    const relaid = relayBlueBrickTrack(map, await mapper.map(map), bundle);
    expect(relaid.issues).toEqual([ALTITUDE, ...issues]);
    const reported = relaid.issues.flatMap((issue) =>
      issue.kind === "altitude" ? [] : [issue.from],
    );
    expect(reported).toEqual(
      expect.arrayContaining([...unjoinedLinks(map, relaid, bundle.trackCatalog)]),
    );
  },
  BUNDLE_TIMEOUT_MS,
);
