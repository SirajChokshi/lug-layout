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

type CatalogPiece = (typeof catalog.pieces)[number];
const placedPieces = new Map<string, PlacedOutline>();

function placedPiece(piece: CatalogPiece, pose: Pose16): PlacedOutline {
  const key = `${piece.id}|${pose.heading}|${pose.position.join(",")}`;
  let outline = placedPieces.get(key);
  if (!outline) {
    outline = PlacedOutline.ofTrackPiece(
      pieceFrameOutline(outlineOf(piece.part), piece.partFrame),
      pose,
    );
    placedPieces.set(key, outline);
  }
  return outline;
}

function track(pieceId: string, pose: Pose16, bedLdu = 0): CrossingTrack {
  const piece = catalog.pieces.find((entry) => entry.id === pieceId);
  if (!piece) throw new Error(`no catalog piece ${pieceId}`);
  return {
    outline: placedPiece(piece, pose),
    bedLdu,
    railTopLdu: railTop(piece.system),
  };
}

function at(xStuds: number, zStuds: number, heading: number): Pose16 {
  return pose16(zeta16([BigInt(xStuds), 0n, 0n, 0n, BigInt(zStuds), 0n, 0n, 0n]), heading);
}

const roadSurfaces = new Map<string, RoadPlacement["surface"]>();

function road(roadwayStuds: number, topLdu = 0): RoadPlacement {
  const key = `${roadwayStuds}|${topLdu}`;
  const surface = roadSurfaces.get(key) ?? plateSurface(roadwayStuds, topLdu);
  roadSurfaces.set(key, surface);
  return { id: 0, x: 0, z: 0, yLdu: 0, rot: 0, surface };
}

function plateSurface(roadwayStuds: number, topLdu: number): RoadPlacement["surface"] {
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
    minX: -half,
    minZ: -half,
    columns: PLATE_STUDS,
    rows: PLATE_STUDS,
    topSixteenths: top,
    studSixteenths: stud,
    road: roadway,
    occupied: new Uint8Array(top.length).fill(1),
  };
}

function straightRunAcross(xStuds = 0, zStuds = 0): CrossingTrack[] {
  return [-24, -8, 8].map((z) => track("ldraw:74746", at(xStuds, zStuds + z, ALONG_Z)));
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
const GATE_TIMEOUT_MS = 240_000;
const PLATE_LDU = PLATE_STUDS * STUD;
const SITE_STUDS = 12 * PLATE_STUDS;
const SITES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [SITE_STUDS, 0],
  [0, SITE_STUDS],
];
const ROAD_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [PLATE_LDU, 0],
  [0, PLATE_LDU],
  [3 * PLATE_LDU, 0],
  [10, PLATE_LDU],
];
const RAISED_LDU = 8;
const TRACK_PIECES = ["ldraw:74746", "ldraw:74746", "ldraw:74747", "ldraw:53401"];
const ACROSS_STUDS = [-21, -10, 0, 10, 21, 32, 42, 53, 96];
const ALONG_STUDS = [-16, -8, 0, 8, 24];
const HEADINGS = [0, ALONG_Z, 2 * ALONG_Z, 3 * ALONG_Z];
const BRIDGE_ACROSS_STUDS = 5;
const NEIGHBOUR_ACROSS_STUDS = 10;
const SCRIPTED_EVERY = 6;

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

function randomRoad(
  random: () => number,
  id: number,
  [siteX, siteZ]: readonly [number, number] = [0, 0],
): RoadPlacement {
  const [x, z] = pick(random, ROAD_SPOTS);
  const plate = road(pick(random, [20, 20, 12]), random() < 0.1 ? RAISED_LDU : 0);
  return { ...plate, id, x: x + siteX * STUD, z: z + siteZ * STUD, rot: Math.floor(random() * 4) };
}

function randomTrack(
  random: () => number,
  [siteX, siteZ]: readonly [number, number] = [0, 0],
): CrossingTrack {
  const heading = pick(random, HEADINGS);
  const across = pick(random, ACROSS_STUDS);
  const along = pick(random, ALONG_STUDS);
  const alongZ = heading % (2 * ALONG_Z) !== 0;
  const pose = alongZ
    ? at(siteX + across, siteZ + along, heading)
    : at(siteX + along, siteZ + across, heading);
  return track(pick(random, TRACK_PIECES), pose, random() < 0.1 ? RAISED_LDU : 0);
}

function without<T>(items: ReadonlyArray<T>, gone: number): T[] {
  return items.filter((_, index) => index !== gone);
}

function siteOf(placement: RoadPlacement): number {
  return SITES.findIndex(
    ([x, z]) => Math.abs(placement.x - x * STUD) + Math.abs(placement.z - z * STUD) < 8 * PLATE_LDU,
  );
}

describe("level crossings kept up to date across edits", () => {
  it(
    "finds, after every edit of 60 generated sequences, exactly the crossings in exactly the order a full levelCrossings finds, as roads and tracks come, go, repeat and change order across three sites far apart, over raised and ground beds, and with roads that share an id",
    () => {
      const random = seeded(0xc055);
      const parts = [rampPart("ldraw:4515"), rampPart("ldraw:3297")];
      const seen = {
        crossed: 0,
        merged: 0,
        split: 0,
        unchanged: 0,
        manySites: 0,
        bridgedMerge: 0,
        bridgedSplit: 0,
        roadUnderTrack: 0,
        sharedId: 0,
        adjacentBeds: 0,
        repeated: 0,
        reordered: 0,
      };
      let nextId = 0;
      for (let sequence = 0; sequence < SEQUENCES; sequence++) {
        const gate = new LevelCrossings(parts);
        const scripted = sequence % SCRIPTED_EVERY === 0;
        const [scriptX, scriptZ] = SITES[1] ?? [0, 0];
        let roads: RoadPlacement[] = SITES.map((site, index) =>
          scripted && index === 1
            ? { ...road(20), id: nextId++, x: scriptX * STUD, z: scriptZ * STUD }
            : randomRoad(random, nextId++, site),
        );
        let tracks: CrossingTrack[] = SITES.flatMap(([x, z]) => straightRunAcross(x, z));
        let before = levelCrossings(roads, tracks, parts);
        expect(gate.crossings(roads, tracks)).toEqual(before);
        let checked = { roads, tracks };
        const check = (kind: string) => {
          const expected =
            roads === checked.roads && tracks === checked.tracks
              ? before
              : levelCrossings(roads, tracks, parts);
          checked = { roads, tracks };
          expect(gate.crossings(roads, tracks)).toEqual(expected);
          const ids = new Set(roads.map((r) => r.id));
          if (ids.size < roads.length) seen.sharedId++;
          const roadsById = (id: number) => roads.filter((r) => r.id === id);
          const sites = new Set(
            expected.flatMap((c) => c.roads.flatMap((id) => roadsById(id).map(siteOf))),
          );
          if (sites.size >= 3) seen.manySites++;
          const heights = (c: (typeof expected)[number]) =>
            new Set(c.roads.flatMap((id) => roadsById(id).map((r) => r.surface.topSixteenths[0])));
          if (expected.some((c) => heights(c).size > 1)) seen.adjacentBeds++;
          if (expected.length > 0) seen.crossed++;
          if (expected.length < before.length && tracks.length > 0) seen.merged++;
          if (expected.length > before.length && before.length > 0) seen.split++;
          if (kind === "track added" && expected.length < before.length) seen.bridgedMerge++;
          if (kind === "track removed" && expected.length > before.length) seen.bridgedSplit++;
          if (kind === "road added" && expected.length > before.length) seen.roadUnderTrack++;
          if (JSON.stringify(expected) === JSON.stringify(before)) seen.unchanged++;
          before = expected;
        };
        if (scripted) {
          const across = (studs: number, bedLdu = 0) =>
            track("ldraw:74746", at(scriptX + studs, scriptZ, ALONG_Z), bedLdu);
          tracks = [...tracks, across(NEIGHBOUR_ACROSS_STUDS)];
          check("track added");
          const bridge = across(BRIDGE_ACROSS_STUDS);
          tracks = [...tracks, bridge];
          check("track added");
          tracks = tracks.filter((t) => t !== bridge);
          check("track removed");
          const raised = { ...road(20, RAISED_LDU), id: nextId++ };
          roads = [...roads, { ...raised, x: scriptX * STUD + PLATE_LDU, z: scriptZ * STUD }];
          check("road added");
          tracks = [
            ...tracks,
            across(PLATE_STUDS / 2 - 1),
            across(PLATE_STUDS / 2 + 4, RAISED_LDU),
          ];
          check("track added");
        }
        for (let edit = 0; edit < EDITS; edit++) {
          const roll = random();
          const site = pick(random, SITES);
          let kind = "other";
          if (roll < 0.13) {
            const reuse = roads.length > 0 && random() < 0.15;
            const id = reuse ? (roads[0]?.id ?? nextId++) : nextId++;
            roads = [...roads, randomRoad(random, id, site)];
            kind = "road added";
          } else if (roll < 0.22 && roads.length > 0) {
            roads = without(roads, Math.floor(random() * roads.length));
          } else if (roll < 0.47) {
            tracks = [...tracks, randomTrack(random, site)];
            kind = "track added";
          } else if (roll < 0.67 && tracks.length > 0) {
            tracks = without(tracks, Math.floor(random() * tracks.length));
            kind = "track removed";
          } else if (roll < 0.73 && tracks.length > 0) {
            tracks = [...tracks, pick(random, tracks)];
            seen.repeated++;
          } else if (roll < 0.8 && tracks.length > 0) {
            const slot = Math.floor(random() * tracks.length);
            const old = tracks[slot];
            if (old) tracks = tracks.map((t, i) => (i === slot ? { ...old } : t));
          } else if (roll < 0.84) {
            tracks = tracks.toReversed();
            seen.reordered++;
          } else if (roll < 0.88) {
            roads = roads.toReversed();
            seen.reordered++;
          }
          check(kind);
        }
      }
      expect(Object.entries(seen).filter(([, count]) => count === 0)).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );

  it("merges a crossing with a new track whose covered cells only share an edge with its cells, on a road whose stud cells sit half a stud off the track's edges, for track no ramp part fits", () => {
    const parts: ReadonlyArray<RampPart> = [];
    const roads = [{ ...road(20), x: STUD / 2 }];
    const crossing = straightRunAcross();
    const beside = track("ldraw:74746", at(9, 0, ALONG_Z));
    expect(beside.outline.bounds.minX).toBeGreaterThan(SLEEPER_END + STUD / 2);
    const gate = new LevelCrossings(parts);
    expect(gate.crossings(roads, crossing)).toHaveLength(1);
    const merged = gate.crossings(roads, [...crossing, beside]);
    expect(merged).toEqual(levelCrossings(roads, [...crossing, beside], parts));
    expect(merged.map((c) => c.tracks)).toEqual([[0, 1, 2, 3]]);
  });

  it("finds the crossing a road added under a track makes, though that track crossed nothing before and lies far from every crossing", () => {
    const parts = [rampPart("ldraw:4515")];
    const far = SITE_STUDS;
    const alone = track("ldraw:74746", at(far, 0, ALONG_Z));
    const tracks = [...straightRunAcross(), alone];
    const gate = new LevelCrossings(parts);
    const before = gate.crossings([road(20)], tracks);
    const roads = [road(20), { ...road(20), id: 1, x: far * STUD }];
    const after = gate.crossings(roads, tracks);
    expect(after).toEqual(levelCrossings(roads, tracks, parts));
    expect(after.length).toBe(before.length + 1);
  });

  it("finds the crossing a new track makes across a road far from every crossing", () => {
    const parts = [rampPart("ldraw:4515")];
    const far = SITE_STUDS;
    const roads = [road(20), { ...road(20), id: 1, x: far * STUD }];
    const gate = new LevelCrossings(parts);
    const before = gate.crossings(roads, straightRunAcross());
    const tracks = [...straightRunAcross(), ...straightRunAcross(far, 0)];
    const after = gate.crossings(roads, tracks);
    expect(after).toEqual(levelCrossings(roads, tracks, parts));
    expect(after.length).toBe(before.length + 1);
  });

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
