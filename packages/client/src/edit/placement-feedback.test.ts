import { expect, it } from "vitest";
import { ghostVerdict, lineText, placementFeedback } from "./placement-feedback.ts";
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
  status: { readonly inferred?: number; readonly unverified?: number } = {},
): HoverMateCount {
  return {
    kind,
    partnerKinds,
    connectors: joints * 2,
    joints,
    partners,
    inferred: status.inferred ?? 0,
    unverified: status.unverified ?? 0,
  };
}

function hover(placement: Partial<PlacementHover>) {
  return {
    mode: "place",
    ghostSettled: false,
    hover: {
      refusal: null,
      placement: {
        pose: { x: 320, z: 0, yPlates: 0, rot: 0 },
        accepted: true,
        hit: null,
        mates: [],
        lifted: false,
        restsOn: [],
        turnBlocksSnap: false,
        turnMates: [],
        ...placement,
      },
    },
  };
}

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
    lines: ["2 round sockets engage custom-modular-pinned and custom-modular-holes (3 unverified)"],
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
    name: "a refusal naming the hit part by id when it has no label, and a turn that would meet pins",
    placement: {
      accepted: false,
      hit: HIT,
      turnBlocksSnap: true,
      turnMates: [mate(TECHNIC_HOLE, [FRICTION_PIN], 2, [PINNED])],
    },
    tone: "refused",
    lines: ["Hits ldraw:3700 in Market Street at cell (16, -7)", "Turn it to meet the pins"],
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
  });
});
