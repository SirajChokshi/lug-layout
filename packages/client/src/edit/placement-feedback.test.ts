import { expect, it } from "vitest";
import type { FillView } from "./fill-tool.ts";
import {
  ghostVerdict,
  lineText,
  placementFeedback,
  type PlacementView,
} from "./placement-feedback.ts";
import { distinctJoints } from "./placement-hover.ts";
import { refusalText } from "./placement-hover-view.ts";
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
  stud: false,
  sections: [
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
    { profile: "round", sizeLdu: 6, lengthLdu: 16 },
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
  ],
};
const FRICTION_PIN: ConnectorKindView = {
  gender: "male",
  slides: false,
  stud: false,
  sections: [
    { profile: "round", sizeLdu: 8, lengthLdu: 2 },
    { profile: "round", sizeLdu: 6, lengthLdu: 12 },
    { profile: "flare", sizeLdu: 6.25, lengthLdu: 6 },
  ],
};
const AXLE_END: ConnectorKindView = {
  gender: "male",
  slides: true,
  stud: false,
  sections: [{ profile: "axle", sizeLdu: 6, lengthLdu: 20 }],
};
const BAR_TUBE: ConnectorKindView = {
  gender: "female",
  slides: true,
  stud: false,
  sections: [{ profile: "round", sizeLdu: 4, lengthLdu: 16 }],
};
const SHORT_TUBE: ConnectorKindView = {
  gender: "female",
  slides: true,
  stud: false,
  sections: [{ profile: "round", sizeLdu: 4, lengthLdu: 8 }],
};
const STUD: ConnectorKindView = {
  gender: "male",
  slides: false,
  stud: true,
  sections: [{ profile: "round", sizeLdu: 6, lengthLdu: 4 }],
};
const BRICK_SOCKET: ConnectorKindView = {
  gender: "female",
  slides: false,
  stud: false,
  sections: [{ profile: "round", sizeLdu: 6, lengthLdu: 20 }],
};
const PLATE_SOCKET: ConnectorKindView = {
  gender: "female",
  slides: false,
  stud: false,
  sections: [{ profile: "round", sizeLdu: 6, lengthLdu: 4 }],
};

function model(label: string, x: number): PlacedModelView {
  return { item: `custom:${label}`, label, pose: { x, z: 0, yPlates: 0, rot: 0 } };
}

const PINNED = model("custom-modular-pinned", 0);
const HOLED = model("custom-modular-holes", 320);
const BASEPLATE = model("Baseplate 32 x 32", 0);
const ROAD = model("Baseplate 32 x 32 Road 6-Stud Straight", -320);
const UNLABELLED_ROAD = { ...model("", -320), item: "custom:road-loop.mpd" };
const WAITING = { settled: false, turnSettled: false, accepted: false, hit: null };
const QUEUED = { queuedPlacement: { x: -320, z: 320 } };
const LOADING_BASEPLATE = {
  pendingItem: "ldraw:3811@2",
  catalog: [{ id: "ldraw:3811@2", label: "Baseplate_32_x_32, Green" }],
};

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

const HELD = "custom-modular-holes.ldr";

function hover(
  placement: Partial<PlacementHover>,
  view: Partial<PlacementView> = {},
): PlacementView {
  const refused = placement.accepted === false;
  return {
    mode: "place",
    ghostSettled: false,
    gesture: null,
    fillDraft: null,
    pendingItem: null,
    queuedPlacement: null,
    catalog: [],
    placementMode: "assist",
    placementModeOverride: false,
    hover: {
      refusal: refused ? refusalText(HELD, placement.hit ?? null) : null,
      placement: {
        pose: { x: 320, z: 0, yPlates: 0, rot: 0 },
        accepted: true,
        hit: null,
        mates: [],
        joints: distinctJoints(placement.mates ?? []),
        lifted: false,
        restsOn: [],
        lifts: [],
        turnBlocksSnap: false,
        turnMates: [],
        turnJoints: distinctJoints(placement.turnMates ?? []),
        mode: "assist",
        magnetised: false,
        magnet: { dxLdu: 0, dzLdu: 0, dyPlates: 0, distanceLdu: 0 },
        assistNeighbourhood: { ldu: 40, cells: 2, plates: 2 },
        settled: true,
        turnSettled: true,
        waitingOn: null,
        ...placement,
      },
    },
    ...view,
  };
}

const FILL: FillView = { wanted: 4, refused: 0, alreadyThere: 0, overLimit: false };

const HIT: HoverRefusalHit = {
  placed: model("Market Street", 0),
  part: "ldraw:3700",
  partLabel: "Technic Brick 1 x 2 with Hole",
  cellX: 16,
  cellZ: -7,
  placedBottomLdu: 0,
  placedTopLdu: 24,
  heldBottomLdu: 8,
  heldTopLdu: 32,
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
    name: "a model whose own plates take the place of two plates under it, which it offers to lift",
    placement: { lifts: [BASEPLATE, model("Baseplate 32 x 32", 640)] },
    tone: "fits",
    lines: ["Click: lift the 2 plates under it"],
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
      `${HELD} would overlap ldraw:3700 in Market Street at stud 16, -7. Move it clear or turn it.`,
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
    name: "stacked stud kinds that read alike as one line counting their distinct joints, badges summed, no lead line, no partner named and the support named from what it rests on",
    placement: {
      pose: { x: 0, z: 0, yPlates: 3, rot: 0 },
      lifted: true,
      restsOn: [PINNED],
      mates: [
        mate(BRICK_SOCKET, [STUD], 3, [], { jointIds: [0, 1, 2], unverified: 1 }),
        mate(PLATE_SOCKET, [STUD], 2, [], { jointIds: [2, 3], unverified: 2 }),
      ],
    },
    tone: "mates",
    lines: ["4 studs hold it (3 unverified)", "Lands 3 plates up on custom-modular-pinned"],
  },
  {
    name: "kinds that read alike but name different partners as their own lines under the lead line",
    placement: {
      mates: [
        mate(BAR_TUBE, [AXLE_END], 2, [PINNED], { jointIds: [0, 1] }),
        mate(SHORT_TUBE, [AXLE_END], 2, [HOLED], { jointIds: [2, 3] }),
      ],
    },
    tone: "mates",
    lines: [
      "Mates at 4 joints",
      "2 round sockets take 2 axles from custom-modular-pinned",
      "2 round sockets take 2 axles from custom-modular-holes",
    ],
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
  {
    name: "a wait on a neighbour's connector data, naming the neighbour and nothing else",
    placement: { ...WAITING, waitingOn: { placed: ROAD, failed: false } },
    tone: "waiting",
    lines: ["Waiting for Baseplate 32 x 32 Road 6-Stud Straight's connector data…"],
  },
  {
    name: "a neighbour whose connector data failed to load, as a refusal that names it",
    placement: { ...WAITING, settled: true, waitingOn: { placed: ROAD, failed: true } },
    tone: "refused",
    lines: [
      "Can't place here: Baseplate 32 x 32 Road 6-Stud Straight's connector data didn't load",
    ],
  },
  {
    name: "a click queued while waiting on a neighbour with no label, the wait last and named by the neighbour's id",
    placement: { ...WAITING, waitingOn: { placed: UNLABELLED_ROAD, failed: false } },
    view: QUEUED,
    tone: "waiting",
    lines: [
      "Queued: placing at stud -16, 16 when ready",
      "Waiting for custom:road-loop.mpd's connector data…",
    ],
  },
  {
    name: "a click still queued after the pointer moved on to a pose that mates",
    placement: { mates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])] },
    view: QUEUED,
    tone: "mates",
    lines: [
      "2 pin holes line up flush with custom-modular-pinned, 2 pins go in",
      "Queued: placing at stud -16, 16 when ready",
    ],
  },
  {
    name: "the held item loading, named by its catalog label, wherever the pointer is",
    placement: {},
    view: { ...LOADING_BASEPLATE, hover: null },
    tone: "waiting",
    lines: ["Loading Baseplate 32 x 32, Green…"],
  },
  {
    name: "a click queued while the held item loads, the queue first and the loading cue last",
    placement: {},
    view: { ...QUEUED, ...LOADING_BASEPLATE, hover: { refusal: null, placement: null } },
    tone: "waiting",
    lines: ["Queued: placing at stud -16, 16 when ready", "Loading Baseplate 32 x 32, Green…"],
  },
] as const)("states $name", (row) => {
  const { placement, tone, lines } = row;
  const feedback = placementFeedback(hover(placement, "view" in row ? row.view : {}));

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

it("reads an unsettled assist hover or a wait on connector data as neutral, never as precise's refusal, and the settled hover or failed load as its verdict", () => {
  const provisional = hover({ accepted: false, hit: HIT, settled: false });
  const settled = hover({ accepted: false, hit: HIT, settled: true });
  const waiting = hover({ ...WAITING, waitingOn: { placed: ROAD, failed: false } });
  const failed = hover({ ...WAITING, settled: true, waitingOn: { placed: ROAD, failed: true } });
  expect({
    provisional: read(provisional),
    waiting: read(waiting).ghost,
    failed: read(failed).ghost,
    settled: read(settled),
  }).toEqual({
    provisional: {
      tone: "pending",
      lines: ["Finding a fit…"],
      ghost: { tone: null, hit: null, precise: false },
    },
    waiting: { tone: null, hit: null, precise: false },
    failed: { tone: "refused", hit: null, precise: false },
    settled: {
      tone: "refused",
      lines: [
        `${HELD} would overlap Technic Brick 1 x 2 with Hole in Market Street at stud 16, -7. Move it clear or turn it.`,
      ],
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
  "brick-2x4 would overlap Plate 2 x 8 in 10014-1 Caboose (2001) at stud 3, -2. Move it clear or turn it.",
  "MILS Basic Terrain Module would overlap Technic Brick 1 x 4 with Holes in MILS Basic Terrain Module at stud -11, 64. Move it clear or turn it.",
  "brick-2x4 has nothing to rest on here: none of its connectors mate, and it isn't on the table. Move it onto studs or onto the table.",
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
