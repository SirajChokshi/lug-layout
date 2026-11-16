import type { LdrawLibrary } from "../ldraw/library.ts";
import { ZETA16_ORDER } from "../track/cyclotomic.ts";
import { loadTrackEndMarkers, type RelativeTrackEnd } from "../track/track-ends.ts";
import {
  composeDivergingWithCurve,
  crossCheckLdcadTrackSnaps,
  measureBaseplate,
  measureFlexBend,
  measureMarkingBands,
  measureRecessedPlate,
  measureRails,
  measureStudZones,
  reportTrackEnds,
  type TrackEndReport,
} from "./geometry.ts";

interface GeometryLibraries {
  readonly official: LdrawLibrary;
  readonly shadow: LdrawLibrary;
}

const OFFICIAL_TRACK = ["53401", "53400", "74746", "74747", "75541-f1", "75542-f1", "32087"];
const LDCAD_TRACK = ["53400", "32087"];
const ENTRY_HEADING_STEPS = ZETA16_ORDER / 2;
const STRAIGHT_HEADING_STEPS = 0;
const RAIL_SECTION_X = 20;
const BASEPLATES = ["3811", "3857", "3867", "4186", "782", "44336", "2358", "610", "606", "30225b"];
const ROAD_STUD_ZONES = ["44336", "44341", "44342", "44343", "2358", "610", "606", "30225b"];
const ROAD_MARKINGS = ["44336p01", "44336p04"];
const RECESSED_ROAD_PLATES = ["69958", "71772", "71772p01"];
const FLEX = ["64022c01", "64022c02"];
const FLEX_MOVING_HALF = "88493.dat";

function composeSwitchWithCurve(
  switchPart: TrackEndReport | undefined,
  curve: TrackEndReport | undefined,
) {
  return composeDivergingWithCurve(turningEnd(switchPart), turningEnd(curve), [
    switchPart?.part ?? "",
    curve?.part ?? "",
  ]);
}

function turningEnd(report: TrackEndReport | undefined): RelativeTrackEnd {
  const end = report?.relative.find(
    (candidate) =>
      candidate.headingSteps !== ENTRY_HEADING_STEPS &&
      candidate.headingSteps !== STRAIGHT_HEADING_STEPS,
  );
  if (end === undefined) throw new Error(`no turning end on ${report?.part ?? "missing part"}`);
  return end;
}

export function buildGeometryReport(
  libraries: GeometryLibraries,
  topStudPrimitives: ReadonlyArray<string>,
) {
  const markers = loadTrackEndMarkers();
  const official = new Map(
    OFFICIAL_TRACK.map((part) => [part, reportTrackEnds(libraries.official, part, markers)]),
  );
  return {
    trackEnds: [...official.values()],
    ldcadTrackSnapCrossCheck: LDCAD_TRACK.map((part) =>
      crossCheckLdcadTrackSnaps(
        libraries.official,
        libraries.shadow,
        part,
        official.get(part)?.ends ?? [],
      ),
    ),
    switchThenReverseCurve: [
      composeSwitchWithCurve(official.get("75541-f1"), official.get("74747")),
      composeSwitchWithCurve(official.get("75542-f1"), official.get("74747")),
    ],
    rails: [
      measureRails(libraries.official, "74746", RAIL_SECTION_X),
      measureRails(libraries.official, "53401", RAIL_SECTION_X),
    ],
    baseplates: BASEPLATES.map((part) => measureBaseplate(libraries.official, part)),
    roadStudZones: ROAD_STUD_ZONES.map((part) =>
      measureStudZones(libraries.official, part, topStudPrimitives),
    ),
    roadMarkings: ROAD_MARKINGS.map((part) => ({
      part,
      markingBandsByColor: measureMarkingBands(libraries.official, part),
    })),
    recessedRoadPlates: RECESSED_ROAD_PLATES.map((part) =>
      measureRecessedPlate(libraries.official, part, topStudPrimitives),
    ),
    flex: FLEX.map((part) => measureFlexBend(libraries.official, part, FLEX_MOVING_HALF)),
  };
}
