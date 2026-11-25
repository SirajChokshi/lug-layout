import { pose16, zeta16, type Pose16 } from "@brr/math";
import { LevelCrossingFacts, PlanOutlinesFile, TrackCatalog } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import crossingJson from "../../../docs/verified-facts/level-crossing.json" with { type: "json" };
import outlinesJson from "../../../docs/verified-facts/plan-outlines.json" with { type: "json" };
import catalogJson from "../../../docs/verified-facts/track-catalog.json" with { type: "json" };
import {
  LevelCrossings,
  levelCrossings,
  type CrossingTrack,
  type RampCandidate,
  type RampPart,
} from "./level-crossings.ts";
import { PlacedOutline } from "./plan/placed-outline.ts";
import { NO_STUD, type RoadPlacement } from "./road-joins.ts";
import { pieceFrameOutline } from "./track/piece-outline.ts";

const facts = decodedOrThrow(decode(LevelCrossingFacts, crossingJson), "level-crossing.json");
const outlines = decodedOrThrow(decode(PlanOutlinesFile, outlinesJson), "plan-outlines.json");
const catalog = decodedOrThrow(decode(TrackCatalog, catalogJson), "track-catalog.json");

const STUD = 20;
const SIXTEENTHS = 16;
const PLATE_STUDS = 32;
const ALONG_Z = 4;
const SLEEPER_END = 80;

function outlineOf(part: string) {
  const outline = outlines.outlines.find((entry) => entry.part === part);
  if (!outline) throw new Error(`no plan outline for ${part}`);
  return outline.rings;
}

function rampPart(part: string): RampPart {
  const ramp = facts.ramps.find((entry) => entry.part === part);
  if (!ramp) throw new Error(`${part} is not a ramp in level-crossing.json`);
  return { facts: ramp, outline: outlineOf(part) };
}

function railTop(system: string): number {
  const found = facts.systems.find((entry) => entry.system === system);
  if (!found) throw new Error(`no rail top for ${system}`);
  return found.railTopLdu;
}

function track(pieceId: string, pose: Pose16): CrossingTrack {
  const piece = catalog.pieces.find((entry) => entry.id === pieceId);
  if (!piece) throw new Error(`no catalog piece ${pieceId}`);
  const rings = pieceFrameOutline(outlineOf(piece.part), piece.partFrame);
  return {
    outline: PlacedOutline.ofTrackPiece(rings, pose),
    bedLdu: 0,
    railTopLdu: railTop(piece.system),
  };
}

function at(xStuds: number, zStuds: number, heading: number): Pose16 {
  return pose16(zeta16([BigInt(xStuds), 0n, 0n, 0n, BigInt(zStuds), 0n, 0n, 0n]), heading);
}

function road(roadwayStuds: number, topLdu = 0): RoadPlacement {
  const cells = PLATE_STUDS * PLATE_STUDS;
  const top = new Int32Array(cells).fill(topLdu * SIXTEENTHS);
  const stud = new Int32Array(cells).fill(topLdu * SIXTEENTHS);
  const roadway = new Uint8Array(cells);
  const firstRow = (PLATE_STUDS - roadwayStuds) / 2;
  for (let row = firstRow; row < firstRow + roadwayStuds; row++) {
    for (let column = 0; column < PLATE_STUDS; column++) {
      roadway[row * PLATE_STUDS + column] = 1;
      stud[row * PLATE_STUDS + column] = NO_STUD;
    }
  }
  const half = (PLATE_STUDS * STUD) / 2;
  return {
    id: 0,
    x: 0,
    z: 0,
    yLdu: 0,
    rot: 0,
    surface: {
      minX: -half,
      minZ: -half,
      columns: PLATE_STUDS,
      rows: PLATE_STUDS,
      topSixteenths: top,
      studSixteenths: stud,
      road: roadway,
      occupied: new Uint8Array(top.length).fill(1),
    },
  };
}

function straightRunAcross(): CrossingTrack[] {
  return [-24, -8, 8].map((z) => track("ldraw:74746", at(0, z, ALONG_Z)));
}

function clearOf(
  candidate: RampCandidate,
  parts: ReadonlyArray<RampPart>,
  tracks: ReadonlyArray<CrossingTrack>,
) {
  const part = parts.find((r) => r.facts.part === candidate.part);
  if (!part) throw new Error(`unknown ramp ${candidate.part}`);
  const outline = PlacedOutline.onLattice(part.outline, candidate.x, candidate.z, candidate.rot);
  return tracks.every((t) => !t.outline.overlaps(outline));
}

function onStudLattice([x, z]: readonly [number, number]): boolean {
  return (x - STUD / 2) % STUD === 0 && (z - STUD / 2) % STUD === 0;
}

describe("levelCrossings", () => {
  it("finds the crossing where 9V straights cross a road, and offers ramps flush to the sleeper ends at the rail top", () => {
    const tracks = straightRunAcross();
    const parts = [rampPart("ldraw:4515")];
    const [crossing, ...others] = levelCrossings([road(20)], tracks, parts);
    expect(others).toEqual([]);
    if (!crossing) throw new Error("no crossing");
    expect(crossing.tracks).toEqual([0, 1, 2]);
    expect(crossing.candidates.length).toBeGreaterThan(0);
    for (const candidate of crossing.candidates) {
      const ramp = parts[0]?.facts;
      expect({
        flushSide: candidate.rect.minX === SLEEPER_END || candidate.rect.maxX === -SLEEPER_END,
        undersideOnRoad: candidate.y + (ramp?.undersideY ?? 0) === candidate.undersideLdu,
        reachesRailTop: ramp?.highEdgeLdu === railTop("lego-9v"),
        carriesRoad: candidate.roadwayCovered > 0,
        clearOfTrack: clearOf(candidate, parts, tracks),
        antiStudsOnLattice: candidate.antiStuds.every(onStudLattice),
      }).toEqual({
        flushSide: true,
        undersideOnRoad: true,
        reachesRailTop: true,
        carriesRoad: true,
        clearOfTrack: true,
        antiStudsOnLattice: true,
      });
    }
    const sides = new Set(crossing.candidates.map((c) => Math.sign(c.rect.minX + c.rect.maxX)));
    expect(sides).toEqual(new Set([-1, 1]));
  });

  it("offers ramps from whichever ramp part is in the bundle, here a 3297 instead of a 4515", () => {
    const tracks = straightRunAcross();
    const parts = [rampPart("ldraw:3297")];
    const [crossing] = levelCrossings([road(20)], tracks, parts);
    expect(crossing?.candidates.length).toBeGreaterThan(0);
    for (const candidate of crossing?.candidates ?? []) {
      expect(candidate.part).toBe("ldraw:3297");
      expect(candidate.rect.minX === SLEEPER_END || candidate.rect.maxX === -SLEEPER_END).toBe(
        true,
      );
      expect(clearOf(candidate, parts, tracks)).toBe(true);
    }
  });

  it("follows the roadway's own width: a narrower road crosses fewer studs and still takes flush ramps", () => {
    const tracks = straightRunAcross();
    const parts = [rampPart("ldraw:4515"), rampPart("ldraw:3297")];
    const [wide] = levelCrossings([road(20)], tracks, parts);
    const [narrow] = levelCrossings([road(12)], tracks, parts);
    if (!wide || !narrow) throw new Error("both roads should be crossed");
    expect(narrow.roadwayCells).toBeLessThan(wide.roadwayCells);
    expect(narrow.candidates.length).toBeGreaterThan(0);
    expect(Math.max(...narrow.candidates.map((c) => c.roadwayCovered))).toBeLessThan(
      Math.max(...wide.candidates.map((c) => c.roadwayCovered)) + 1,
    );
  });

  it("treats a curve over the road as a crossing, and offers no ramp that would cut into it", () => {
    const tracks = [
      track("ldraw:74747", at(-8, 0, ALONG_Z)),
      track("ldraw:74747", at(-8, 0, ALONG_Z + 8)),
    ];
    const parts = [rampPart("ldraw:4515"), rampPart("ldraw:3297")];
    const crossings = levelCrossings([road(20)], tracks, parts);
    expect(crossings.length).toBeGreaterThan(0);
    for (const crossing of crossings) {
      for (const candidate of crossing.candidates)
        expect(clearOf(candidate, parts, tracks)).toBe(true);
    }
  });

  it("crosses a one-stud road strip where its own square lies under the track's ends and not a stud beyond them, whatever stands higher beside it in the same stud cell", () => {
    const strip = (centreX: number): RoadPlacement => {
      const rows = PLATE_STUDS;
      const half = (rows * STUD) / 2;
      return {
        id: 0,
        x: centreX,
        z: 0,
        yLdu: 0,
        rot: 0,
        surface: {
          minX: -STUD / 2,
          minZ: -half,
          columns: 1,
          rows,
          topSixteenths: new Int32Array(rows),
          studSixteenths: new Int32Array(rows).fill(NO_STUD),
          road: new Uint8Array(rows).fill(1),
          occupied: new Uint8Array(rows).fill(1),
        },
      };
    };
    const parts = [rampPart("ldraw:4515")];
    const underSleeperEnds = levelCrossings([strip(SLEEPER_END)], straightRunAcross(), parts);
    const besideSleeperEnds = levelCrossings(
      [strip(SLEEPER_END + STUD)],
      straightRunAcross(),
      parts,
    );
    const besideARaisedSurface = levelCrossings(
      [strip(SLEEPER_END), { ...strip(SLEEPER_END + 15), id: 1, yLdu: 48 }],
      straightRunAcross(),
      parts,
    );
    expect(underSleeperEnds.length).toBeGreaterThan(0);
    expect(underSleeperEnds.every((crossing) => crossing.roadwayCells > 0)).toBe(true);
    expect(besideSleeperEnds).toEqual([]);
    expect(besideARaisedSurface).toEqual(underSleeperEnds);
  });

  it("is no crossing where the road's surface stands above the track's bed", () => {
    expect(levelCrossings([road(20, 16)], straightRunAcross(), [rampPart("ldraw:4515")])).toEqual(
      [],
    );
  });
});

const SEQUENCES = 60;
const EDITS = 16;
const GATE_TIMEOUT_MS = 120_000;
const PLATE_LDU = PLATE_STUDS * STUD;
const ROAD_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [PLATE_LDU, 0],
  [0, PLATE_LDU],
  [3 * PLATE_LDU, 0],
  [10, PLATE_LDU],
];
const TRACK_PIECES = ["ldraw:74746", "ldraw:74746", "ldraw:74747", "ldraw:53401"];
const ACROSS_STUDS = [-21, -10, 0, 10, 21, 32, 42, 53, 96];
const ALONG_STUDS = [-16, -8, 0, 8, 24];
const HEADINGS = [0, ALONG_Z, 2 * ALONG_Z, 3 * ALONG_Z];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, choices: ReadonlyArray<T>): T {
  const choice = choices[Math.floor(random() * choices.length)];
  if (choice === undefined) throw new Error("nothing to pick from");
  return choice;
}

function randomRoad(random: () => number, id: number): RoadPlacement {
  const [x, z] = pick(random, ROAD_SPOTS);
  const plate = road(pick(random, [20, 20, 12]), random() < 0.1 ? 8 : 0);
  return { ...plate, id, x, z, rot: Math.floor(random() * 4) };
}

function randomTrack(random: () => number): CrossingTrack {
  const heading = pick(random, HEADINGS);
  const across = pick(random, ACROSS_STUDS);
  const along = pick(random, ALONG_STUDS);
  const alongZ = heading % (2 * ALONG_Z) !== 0;
  return track(
    pick(random, TRACK_PIECES),
    alongZ ? at(across, along, heading) : at(along, across, heading),
  );
}

function without<T>(items: ReadonlyArray<T>, gone: number): T[] {
  return items.filter((_, index) => index !== gone);
}

describe("level crossings kept up to date across edits", () => {
  it(
    "finds, after every edit of 60 generated sequences, exactly the crossings in exactly the order a full levelCrossings finds, as roads and tracks come, go, repeat and change order",
    () => {
      const random = seeded(0xc055);
      const parts = [rampPart("ldraw:4515"), rampPart("ldraw:3297")];
      const seen = { crossed: 0, merged: 0, split: 0, unchanged: 0 };
      let nextId = 0;
      for (let sequence = 0; sequence < SEQUENCES; sequence++) {
        const gate = new LevelCrossings(parts);
        let roads: RoadPlacement[] = [randomRoad(random, nextId++)];
        let tracks: CrossingTrack[] = straightRunAcross();
        let before = levelCrossings(roads, tracks, parts);
        expect(gate.crossings(roads, tracks)).toEqual(before);
        for (let edit = 0; edit < EDITS; edit++) {
          const roll = random();
          if (roll < 0.15) roads = [...roads, randomRoad(random, nextId++)];
          else if (roll < 0.25 && roads.length > 0) {
            roads = without(roads, Math.floor(random() * roads.length));
          } else if (roll < 0.5) tracks = [...tracks, randomTrack(random)];
          else if (roll < 0.7 && tracks.length > 0) {
            tracks = without(tracks, Math.floor(random() * tracks.length));
          } else if (roll < 0.76 && tracks.length > 0) tracks = [...tracks, pick(random, tracks)];
          else if (roll < 0.82 && tracks.length > 0) {
            const slot = Math.floor(random() * tracks.length);
            const old = tracks[slot];
            if (old) tracks = tracks.map((t, i) => (i === slot ? { ...old } : t));
          } else if (roll < 0.86) tracks = tracks.toReversed();
          else if (roll < 0.9) roads = roads.toReversed();
          const expected = levelCrossings(roads, tracks, parts);
          expect(gate.crossings(roads, tracks)).toEqual(expected);
          if (expected.length > 0) seen.crossed++;
          if (expected.length < before.length && tracks.length > 0) seen.merged++;
          if (expected.length > before.length && before.length > 0) seen.split++;
          if (JSON.stringify(expected) === JSON.stringify(before)) seen.unchanged++;
          before = expected;
        }
      }
      expect(Object.values(seen).every((count) => count > 0)).toBe(true);
    },
    GATE_TIMEOUT_MS,
  );

  it("drops the ramps a new track beyond the road's edge would cut into, though the track meets no road", () => {
    const parts = [rampPart("ldraw:4515"), rampPart("ldraw:3297")];
    const roads = [road(20)];
    const crossing = [-24, -8, 8].map((z) => track("ldraw:74746", at(10, z, ALONG_Z)));
    const beyond = track("ldraw:74746", at(21, 0, ALONG_Z));
    expect(beyond.outline.bounds.minX).toBeGreaterThan(PLATE_LDU / 2 + STUD / 2);
    const gate = new LevelCrossings(parts);
    const alone = gate.crossings(roads, crossing);
    const withBeyond = gate.crossings(roads, [...crossing, beyond]);
    expect(withBeyond).toEqual(levelCrossings(roads, [...crossing, beyond], parts));
    expect(withBeyond.map((c) => c.candidates.length)).not.toEqual(
      alone.map((c) => c.candidates.length),
    );
  });

  it("reads road ids only as labels: crossings over roads whose ids rise with gaps are the crossings over the same roads numbered 0, 1, 2…, renumbered", () => {
    const random = seeded(0x1d);
    const parts = [rampPart("ldraw:4515")];
    for (let layout = 0; layout < 40; layout++) {
      const dense = Array.from({ length: 2 + Math.floor(random() * 3) }, (_, id) =>
        randomRoad(random, id),
      );
      const tracks = [...straightRunAcross(), randomTrack(random), randomTrack(random)];
      let next = 0;
      const sparseIds = dense.map(() => (next += 1 + Math.floor(random() * 7)));
      const sparse = dense.map((r, rank) => ({ ...r, id: sparseIds[rank] ?? 0 }));
      const rankOf = new Map(sparseIds.map((id, rank) => [id, rank]));
      expect(
        levelCrossings(sparse, tracks, parts).map((c) => ({
          ...c,
          roads: c.roads.map((id) => rankOf.get(id)),
        })),
      ).toEqual(levelCrossings(dense, tracks, parts));
    }
  });
});
