import { expect, it } from "vitest";
import type { FillView } from "./fill-tool.ts";
import {
  ghostVerdict,
  lineText,
  placementFeedback,
  type PlacementView,
} from "./placement-feedback.ts";
import { distinctJoints } from "./placement-hover.ts";
import type {
  ConnectorKindView,
  HoverMateCount,
  HoverRefusalHit,
  PlacedModelView,
  PlacementHover,
} from "./placement-hover.ts";

const TECHNIC_HOLE: ConnectorKindView = {
  gender: "female",
  slides: true,
  sections: [
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
    { profile: "round", sizeLdu: 6, lengthLdu: 16 },
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
  ],
};
const FRICTION_PIN: ConnectorKindView = {
  gender: "male",
  slides: false,
  sections: [
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
    { profile: "round", sizeLdu: 6, lengthLdu: 12 },
    { profile: "flare", sizeLdu: 6.25, lengthLdu: 6 },
  ],
};
const AXLE_END: ConnectorKindView = {
  gender: "male",
  slides: true,
  sections: [{ profile: "axle", sizeLdu: 6, lengthLdu: 20 }],
};
const BAR_TUBE: ConnectorKindView = {
  gender: "female",
  slides: true,
  sections: [{ profile: "round", sizeLdu: 4, lengthLdu: 16 }],
};

function model(label: string, x: number): PlacedModelView {
  return { item: `custom:${label}`, label, pose: { x, z: 0, yPlates: 0, rot: 0 } };
}

const PINNED = model("custom-modular-pinned", 0);
const HOLED = model("custom-modular-holes", 320);
const BASEPLATE = model("Baseplate 32 x 32", 0);

function mate(
  kind: ConnectorKindView,
  partnerKinds: ReadonlyArray<ConnectorKindView>,
  joints: number,
  partners: ReadonlyArray<PlacedModelView>,
  status: {
    readonly inferred?: number;
    readonly unverified?: number;
    readonly jointIds?: ReadonlyArray<number>;
  } = {},
): HoverMateCount {
  return {
    kind,
    partnerKinds,
    connectors: joints * 2,
    joints,
    jointIds: new Set(status.jointIds ?? Array.from({ length: joints }, (_, joint) => joint)),
    partners,
    inferred: status.inferred ?? 0,
    unverified: status.unverified ?? 0,
  };
}

function hover(placement: Partial<PlacementHover>): PlacementView {
  return {
    mode: "place",
    ghostSettled: false,
    gesture: null,
    fillDraft: null,
    placementMode: "assist",
    placementModeOverride: false,
    hover: {
      refusal: null,
      placement: {
        pose: { x: 320, z: 0, yPlates: 0, rot: 0 },
        accepted: true,
        hit: null,
        mates: [],
        joints: distinctJoints(placement.mates ?? []),
        lifted: false,
        restsOn: [],
        turnBlocksSnap: false,
        turnMates: [],
        turnJoints: distinctJoints(placement.turnMates ?? []),
        mode: "assist",
        magnetised: false,
        magnet: { dxLdu: 0, dzLdu: 0, dyPlates: 0, distanceLdu: 0 },
        assistNeighbourhood: { ldu: 40, cells: 2, plates: 2 },
        settled: true,
        turnSettled: true,
        ...placement,
      },
    },
  };
}

const FILL: FillView = { wanted: 4, refused: 0, overLimit: false };

const HIT: HoverRefusalHit = {
  placed: model("Market Street", 0),
  part: "ldraw:3700",
  partLabel: null,
  cellX: 16,
  cellZ: -7,
  placedBottomLdu: 0,
  placedTopLdu: 24,
  heldBottomLdu: 8,
  heldTopLdu: 32,
  byColumnOnly: false,
};

it.each([
  {
    name: "held pin holes taking a neighbour's pins",
    placement: { mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])] },
    tone: "mates",
    lines: ["2 pin holes line up flush with custom-modular-pinned, 2 pins go in"],
  },
  {
    name: "held pins going into a neighbour's pin holes",
    placement: { mates: [mate(FRICTION_PIN, [TECHNIC_HOLE], 2, [HOLED])] },
    tone: "mates",
    lines: ["2 pin holes on custom-modular-holes line up flush, 2 pins go in"],
  },
  {
    name: "a pin hole entered by an axle, which is never called a pin",
    placement: { mates: [mate(TECHNIC_HOLE, [AXLE_END], 1, [PINNED])] },
    tone: "mates",
    lines: ["1 pin hole takes 1 axle from custom-modular-pinned"],
  },
  {
    name: "a plain sliding tube, partners of mixed kinds, with unverified connectors",
    placement: {
      mates: [mate(BAR_TUBE, [FRICTION_PIN, AXLE_END], 2, [PINNED, HOLED], { unverified: 3 })],
    },
    tone: "mates",
    lines: [
      "2 round sockets take connectors from custom-modular-pinned and custom-modular-holes (3 unverified)",
    ],
  },
  {
    name: "a pose lifted onto a baseplate, with an inferred mate",
    placement: {
      pose: { x: 0, z: 0, yPlates: 3, rot: 0 },
      lifted: true,
      restsOn: [BASEPLATE],
      mates: [mate(AXLE_END, [], 1, [], { inferred: 1 })],
    },
    tone: "mates",
    lines: ["1 axle goes in (1 inferred)", "Lands 3 plates up on Baseplate 32 x 32"],
  },
  {
    name: "a refusal naming the hit part by id when its label is empty, and a turn that would meet unverified pins",
    placement: {
      accepted: false,
      hit: { ...HIT, partLabel: "" },
      turnBlocksSnap: true,
      turnMates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED], { unverified: 2 })],
    },
    tone: "refused",
    lines: [
      "Hits ldraw:3700 in Market Street at cell (16, -7)",
      "Turn it to meet the pins (2 unverified)",
    ],
  },
  {
    name: "a precise hover still carrying a magnet, a mate with no joints and a lift of no plates, none of which it claims",
    placement: {
      mode: "precise",
      magnetised: true,
      magnet: { dxLdu: -20, dzLdu: 0, dyPlates: 0, distanceLdu: 20 },
      mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 0, [PINNED])],
      lifted: true,
    },
    tone: "fits",
    lines: [],
  },
  {
    name: "a refusal from the column check alone, which names no part and invents none",
    placement: {
      accepted: false,
      hit: { ...HIT, part: null, partLabel: null, byColumnOnly: true },
    },
    tone: "refused",
    lines: [
      "Hits the column of Market Street at cell (16, -7), though no part is in that height band (column check)",
    ],
  },
  {
    name: "a refusal outside the column check that still names no part, which names the model and cell only",
    placement: { accepted: false, hit: { ...HIT, part: null, partLabel: null } },
    tone: "refused",
    lines: ["Hits Market Street at cell (16, -7)"],
  },
  {
    name: "a pose magnetised a stud onto a neighbour's pins",
    placement: {
      magnetised: true,
      magnet: { dxLdu: -20, dzLdu: 0, dyPlates: 0, distanceLdu: 20 },
      mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])],
    },
    tone: "mates",
    lines: [
      "Snapped 1 stud to meet the pins",
      "2 pin holes line up flush with custom-modular-pinned, 2 pins go in",
    ],
  },
  {
    name: "a pose magnetised across and up onto partners of mixed kinds",
    placement: {
      magnetised: true,
      magnet: { dxLdu: 40, dzLdu: 20, dyPlates: 3, distanceLdu: 52 },
      mates: [mate(BAR_TUBE, [FRICTION_PIN, AXLE_END], 1, [HOLED])],
    },
    tone: "mates",
    lines: [
      "Snapped 2 by 1 studs and 3 plates up to mate",
      "1 round socket takes connectors from custom-modular-holes",
    ],
  },
  {
    name: "a settled verdict whose turn probe hasn't settled, which says nothing about turning",
    placement: {
      turnSettled: false,
      turnBlocksSnap: true,
      turnMates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])],
    },
    tone: "fits",
    lines: [],
  },
  {
    name: "a turn whose mates name no single kind",
    placement: {
      turnBlocksSnap: true,
      turnMates: [mate(TECHNIC_HOLE, [FRICTION_PIN, AXLE_END], 2, [PINNED])],
    },
    tone: "fits",
    lines: ["Turn it to snap here"],
  },
] as const)("states $name", ({ placement, tone, lines }) => {
  const feedback = placementFeedback(hover(placement));

  expect({ tone: feedback?.tone, lines: feedback?.lines.map(lineText) }).toEqual({ tone, lines });
});

it("boxes a refusal's hit in its stud cell over the height the held and placed parts share", () => {
  expect(ghostVerdict(hover({ accepted: false, hit: HIT }))).toEqual({
    tone: "refused",
    hit: { minX: 320, minY: 8, minZ: -140, maxX: 340, maxY: 24, maxZ: -120 },
    precise: false,
  });
});

it("marks the ghost precise when the hover was searched in precise mode, settled or not", () => {
  const precise = hover({ mode: "precise" });

  expect([
    ghostVerdict(precise),
    ghostVerdict({ ...precise, ghostSettled: true }),
    ghostVerdict(hover({})),
  ]).toEqual([
    { tone: "fits", hit: null, precise: true },
    { tone: null, hit: null, precise: true },
    { tone: "fits", hit: null, precise: false },
  ]);
});

function read(view: PlacementView) {
  return {
    tone: placementFeedback(view)?.tone,
    lines: placementFeedback(view)?.lines.map(lineText),
    ghost: ghostVerdict(view),
  };
}

it("reads an unsettled assist hover as a neutral search, never as precise's refusal, and the settled hover as its verdict", () => {
  const provisional = hover({ accepted: false, hit: HIT, settled: false });
  const settled = hover({ accepted: false, hit: HIT, settled: true });
  expect({ provisional: read(provisional), settled: read(settled) }).toEqual({
    provisional: {
      tone: "pending",
      lines: ["Finding a fit…"],
      ghost: { tone: null, hit: null, precise: false },
    },
    settled: {
      tone: "refused",
      lines: ["Hits ldraw:3700 in Market Street at cell (16, -7)"],
      ghost: {
        tone: "refused",
        hit: { minX: 320, minY: 8, minZ: -140, maxX: 340, maxY: 24, maxZ: -120 },
        precise: false,
      },
    },
  });
});

it("changes nothing when the turn probe settles without finding a snapping turn", () => {
  const probing = hover({
    turnSettled: false,
    mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])],
  });
  const probed = hover({
    turnSettled: true,
    mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])],
  });

  expect(read(probed)).toEqual(read(probing));
});

function holdingGroup(refusal: string | null): PlacementView {
  return {
    ...hover({ magnetised: true, mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])] }),
    mode: "select",
    gesture: { kind: "move", refusal },
  };
}

it.each([
  "brick-2x4 would hit Plate 2 x 8 in 10014-1 Caboose (2001) at cell 3, -2",
  "MILS Basic Terrain Module would hit Technic Brick 1 x 4 with Holes in MILS Basic Terrain Module at cell -11, 64",
  "brick-2x4 has nothing to rest on here: none of its connectors mate, and it isn't on the table",
])("presents a held group's refusal as it reads, %s, and never a snap or a mate", (refusal) => {
  expect(read(holdingGroup(refusal))).toEqual({
    tone: "refused",
    lines: [refusal],
    ghost: { tone: "refused", hit: null, precise: false },
  });
});

it("tints a held group that would land, says nothing over it, and claims nothing over a box drag or a fill", () => {
  const filling = { ...hover({ accepted: false, hit: HIT }), fillDraft: FILL };
  expect({
    lands: read(holdingGroup(null)),
    boxing: read({ ...holdingGroup(null), gesture: { kind: "box" } }),
    filling: read(filling),
  }).toEqual({
    lands: { tone: "fits", lines: [], ghost: { tone: "fits", hit: null, precise: false } },
    boxing: { tone: undefined, lines: undefined, ghost: null },
    filling: { tone: undefined, lines: undefined, ghost: null },
  });
});

it("leads with the distinct joint count when kinds overlap on the same joints, never the per-kind sum, and keeps each kind's own line", () => {
  const overlapping = hover({
    mates: [
      mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED], { jointIds: [7, 9] }),
      mate(BAR_TUBE, [AXLE_END], 2, [PINNED], { jointIds: [7, 9] }),
    ],
  });
  const placement = overlapping.hover?.placement;

  expect({
    joints: placement?.joints,
    perKindSum: placement?.mates.reduce((sum, each) => sum + each.joints, 0),
    lines: placementFeedback(overlapping)?.lines.map(lineText),
  }).toEqual({
    joints: 2,
    perKindSum: 4,
    lines: [
      "Mates at 2 joints",
      "2 pin holes line up flush with custom-modular-pinned, 2 pins go in",
      "2 round sockets take 2 axles from custom-modular-pinned",
    ],
  });
});
