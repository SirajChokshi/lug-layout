import {
  arcBand,
  arrowHead,
  bar,
  circle,
  mirrored,
  path,
  poly,
  radialBar,
  rect,
  star,
  type Glyph,
  type Point,
} from "./shapes.ts";

const CURVE_CENTER: Point = [16, 16];
const SWITCH_CENTER: Point = [20, 16];
const RAIL = 2;
const SLEEPER = 1.6;
const SLEEPERS_SMALL = [196, 218, 240, 262] as const;
const SLEEPERS_LARGE = [192, 208, 224, 240, 256] as const;

const CURVED_TRACK: Glyph = [
  ...SLEEPERS_SMALL.map((degrees) =>
    radialBar(CURVE_CENTER, 5.5, 15.5, degrees, SLEEPER, "wood", { sizes: [16, 20] }),
  ),
  ...SLEEPERS_LARGE.map((degrees) =>
    radialBar(CURVE_CENTER, 5.5, 15.5, degrees, SLEEPER, "wood", { sizes: [24] }),
  ),
  arcBand(CURVE_CENTER, 7, 7 + RAIL, 180, 270, "steel"),
  arcBand(CURVE_CENTER, 12, 12 + RAIL, 180, 270, "steel"),
];

const POINTER: ReadonlyArray<Point> = [
  [2, 1],
  [2, 13],
  [5, 10],
  [7, 14.5],
  [9, 13.5],
  [7, 9],
  [11, 9],
];

function rulerTicks(): Glyph {
  const inward: Point = [Math.SQRT1_2, Math.SQRT1_2];
  return [2, 3.5, 5, 6.5, 8].map((along, index) => {
    const start: Point = [1.6 + along, 11 - along];
    const length = index % 2 === 0 ? 3 : 1.8;
    return bar(start, [start[0] + inward[0] * length, start[1] + inward[1] * length], 1, "ink");
  });
}

function frameCorners(): Glyph {
  return [
    rect(1, 1, 5, 2, "ink"),
    rect(1, 1, 2, 5, "ink"),
    rect(10, 1, 5, 2, "ink"),
    rect(13, 1, 2, 5, "ink"),
    rect(1, 13, 5, 2, "ink"),
    rect(1, 10, 2, 5, "ink"),
    rect(10, 13, 5, 2, "ink"),
    rect(13, 10, 2, 5, "ink"),
  ];
}

function magnifier(lens: "tint" | "paper"): Glyph {
  return [
    bar([10, 10], [14.5, 14.5], 3, "ink"),
    circle(6.5, 6.5, 5.5, "ink"),
    circle(6.5, 6.5, 3.5, lens),
  ];
}

const UNDO: Glyph = [
  path("ink", [
    { op: "M", to: [5, 4] },
    { op: "L", to: [10, 4] },
    { op: "A", radius: 4.5, large: false, sweep: true, to: [10, 13] },
    { op: "L", to: [5, 13] },
    { op: "L", to: [5, 11] },
    { op: "L", to: [10, 11] },
    { op: "A", radius: 2.5, large: false, sweep: false, to: [10, 6] },
    { op: "L", to: [5, 6] },
    { op: "Z" },
  ]),
  poly("ink", [
    [1, 5],
    [6, 0.5],
    [6, 9.5],
  ]),
];

export const ICON_GLYPHS = {
  select: [
    rect(8, 8, 7, 7, "accent", { radius: 1 }),
    rect(9, 9, 5, 5, "tint"),
    poly("ink", POINTER, { halo: true }),
  ],
  track: CURVED_TRACK,
  ruler: [
    poly("ink", [
      [0, 11],
      [11, 0],
      [16, 5],
      [5, 16],
    ]),
    poly("warn", [
      [1.6, 11],
      [11, 1.6],
      [14.4, 5],
      [5, 14.4],
    ]),
    ...rulerTicks(),
  ],
  measure: [
    rect(1, 2, 2, 12, "ink"),
    rect(13, 2, 2, 12, "ink"),
    rect(5, 7, 6, 2, "accent"),
    poly("accent", [
      [3, 8],
      [7, 4],
      [7, 12],
    ]),
    poly("accent", [
      [13, 8],
      [9, 4],
      [9, 12],
    ]),
  ],
  text: [
    rect(1, 2, 11, 2, "ink"),
    rect(1, 2, 2, 4, "ink"),
    rect(10, 2, 2, 4, "ink"),
    rect(5, 2, 3, 11, "ink"),
    rect(3, 12, 7, 2, "ink"),
    rect(14, 5, 1, 9, "accent"),
    rect(13, 5, 3, 1, "accent"),
    rect(13, 13, 3, 1, "accent"),
  ],
  table: [
    poly("wood", [
      [3, 4],
      [13, 4],
      [15, 8],
      [1, 8],
    ]),
    rect(1, 8, 14, 2, "ink"),
    rect(5, 10, 1, 3, "tone"),
    rect(10, 10, 1, 3, "tone"),
    rect(2, 10, 2, 5, "ink"),
    rect(12, 10, 2, 5, "ink"),
  ],
  precise: [
    circle(8, 8, 6, "ink"),
    circle(8, 8, 4, "paper"),
    rect(7, 0, 2, 5, "ink"),
    rect(7, 11, 2, 5, "ink"),
    rect(0, 7, 5, 2, "ink"),
    rect(11, 7, 5, 2, "ink"),
    circle(8, 8, 1, "accent"),
  ],
  "track-straight": [
    rect(2, 2, 12, 2, "wood"),
    rect(2, 7, 12, 2, "wood"),
    rect(2, 12, 12, 2, "wood"),
    rect(4, 1, RAIL, 14, "steel"),
    rect(10, 1, RAIL, 14, "steel"),
  ],
  switch: [
    rect(1, 12, 10, 2, "wood"),
    rect(1, 7, 12, 2, "wood"),
    rect(1, 2, 14, 2, "wood"),
    rect(2, 1, RAIL, 15, "steel"),
    rect(7, 1, RAIL, 15, "steel"),
    arcBand(SWITCH_CENTER, 16, 16 + RAIL, 180, 232, "accent"),
    arcBand(SWITCH_CENTER, 11, 11 + RAIL, 180, 240, "accent"),
    circle(13, 13, 3, "ink", { sizes: [20, 24] }),
    circle(13, 13, 2, "warn", { sizes: [20, 24] }),
  ],
  train: [
    rect(2, 2, 3, 4, "ink"),
    rect(6, 4, 2, 2, "ink"),
    rect(2, 6, 8, 5, "accent"),
    rect(1, 6, 2, 5, "ink"),
    rect(10, 3, 5, 8, "accent"),
    rect(9, 2, 7, 2, "ink"),
    rect(11, 4, 3, 3, "paper"),
    rect(0, 7, 1, 2, "warn"),
    rect(1, 11, 14, 1, "ink"),
    circle(3.5, 13.5, 1.5, "ink"),
    circle(7.5, 13.5, 1.5, "ink"),
    circle(12.5, 13.5, 1.5, "ink"),
  ],
  play: [
    poly("go", [
      [4, 2],
      [14, 8],
      [4, 14],
    ]),
  ],
  stop: [rect(3, 3, 10, 10, "stop", { radius: 1 })],
  all: [
    rect(2, 2, 5, 5, "ink", { radius: 1 }),
    rect(9, 2, 5, 5, "tone", { radius: 1 }),
    rect(2, 9, 5, 5, "tone", { radius: 1 }),
    rect(9, 9, 5, 5, "accent", { radius: 1 }),
  ],
  favorite: [star([8, 8.5], 7.5, 3.2, "gold")],
  "favorite-off": [star([8, 8.5], 7.5, 3.2, "tone"), star([8, 8.6], 4.5, 1.9, "paper")],
  baseplate: [
    rect(1, 1, 14, 14, "go", { radius: 1 }),
    ...[5, 11].flatMap((y) =>
      [5, 11].map((x) => circle(x, y, 2, "paper", { opacity: 0.45, sizes: [16, 20] })),
    ),
    ...[4, 8, 12].flatMap((y) =>
      [4, 8, 12].map((x) => circle(x, y, 1.5, "paper", { opacity: 0.45, sizes: [24] })),
    ),
  ],
  set: [
    poly("ink", [
      [0, 8],
      [8, 1],
      [16, 8],
    ]),
    poly("accent", [
      [2.5, 7],
      [8, 2.5],
      [13.5, 7],
    ]),
    rect(2, 7, 12, 8, "ink"),
    rect(3, 8, 10, 6, "paper"),
    rect(7, 10, 2, 5, "wood"),
    rect(4, 9, 2, 2, "tint"),
    rect(10, 9, 2, 2, "tint"),
  ],
  road: [
    rect(1, 1, 14, 14, "ink"),
    rect(1, 1, 3, 14, "tone"),
    rect(12, 1, 3, 14, "tone"),
    rect(7, 2, 2, 3, "paper"),
    rect(7, 7, 2, 3, "paper"),
    rect(7, 12, 2, 2, "paper"),
  ],
  rotate: [
    arcBand([8, 8.5], 3.5, 5.5, 290, 560, "ink"),
    arrowHead([8, 8.5], 4.5, 200, 3.2, 3.6, "accent"),
  ],
  undo: UNDO,
  redo: mirrored(UNDO),
  delete: [
    rect(6, 1, 4, 2, "ink"),
    rect(2, 3, 12, 2, "stop", { radius: 0.5 }),
    poly("ink", [
      [3, 6],
      [13, 6],
      [12, 15],
      [4, 15],
    ]),
    rect(6, 8, 1, 5, "paper"),
    rect(9, 8, 1, 5, "paper"),
  ],
  find: [...magnifier("tint"), circle(5, 5, 1, "paper")],
  keyboard: [
    rect(0, 3, 16, 11, "ink", { radius: 1.5 }),
    ...[1, 4, 7, 10, 13].map((x) => rect(x, 5, 2, 2, "paper")),
    ...[1, 4, 7, 10].map((x) => rect(x, 8, 2, 2, "paper")),
    rect(13, 8, 2, 2, "accent"),
    rect(4, 11, 8, 1, "paper"),
  ],
  "view-3d": [
    poly("ink", [
      [8, 0],
      [15.5, 4],
      [15.5, 12],
      [8, 16],
      [0.5, 12],
      [0.5, 4],
    ]),
    poly("paper", [
      [8, 1.6],
      [13.6, 4.5],
      [8, 7.4],
      [2.4, 4.5],
    ]),
    poly("tone", [
      [1.8, 5.6],
      [7.3, 8.5],
      [7.3, 14.4],
      [1.8, 11.4],
    ]),
  ],
  "view-plan": [
    rect(1, 1, 14, 14, "ink", { radius: 1 }),
    rect(2, 2, 12, 12, "paper"),
    rect(6, 2, 1, 12, "tone"),
    rect(10, 2, 1, 12, "tone"),
    rect(2, 6, 12, 1, "tone"),
    rect(2, 10, 12, 1, "tone"),
    rect(7, 7, 3, 3, "accent"),
  ],
  fit: [...frameCorners(), rect(5, 6, 3, 4, "tone"), rect(9, 5, 2, 6, "tone")],
  focus: [...frameCorners(), rect(5, 5, 6, 6, "accent", { radius: 1 }), rect(7, 7, 2, 2, "tint")],
  "zoom-in": [...magnifier("paper"), rect(4, 6, 5, 1, "ink"), rect(6, 4, 1, 5, "ink")],
  "zoom-out": [...magnifier("paper"), rect(4, 6, 5, 1, "ink")],
  sidebar: [
    rect(1, 2, 14, 12, "ink", { radius: 1 }),
    rect(2, 3, 12, 10, "paper"),
    rect(2, 3, 4, 10, "tint"),
    rect(6, 3, 1, 10, "ink"),
    rect(3, 5, 2, 1, "accent"),
    rect(3, 7, 2, 1, "accent"),
    rect(3, 9, 2, 1, "accent"),
  ],
  minimap: [
    rect(1, 1, 14, 14, "ink", { radius: 1 }),
    rect(2, 2, 12, 12, "go"),
    rect(2, 10, 12, 2, "tone"),
    rect(7, 4, 6, 5, "accent"),
    rect(8, 5, 4, 3, "go"),
  ],
  world: [
    poly("ink", [
      [2, 0],
      [10, 0],
      [14, 4],
      [14, 16],
      [2, 16],
    ]),
    poly("paper", [
      [3, 1],
      [9.5, 1],
      [13, 4.5],
      [13, 15],
      [3, 15],
    ]),
    poly("tone", [
      [9, 1],
      [13, 5],
      [9, 5],
    ]),
    rect(4, 7, 8, 6, "accent", { radius: 3 }),
    rect(6, 9, 4, 2, "paper", { radius: 1 }),
  ],
  plan: [
    rect(1, 2, 14, 12, "accent", { radius: 1 }),
    rect(1, 6, 14, 1, "paper", { opacity: 0.3 }),
    rect(1, 10, 14, 1, "paper", { opacity: 0.3 }),
    rect(5, 2, 1, 12, "paper", { opacity: 0.3 }),
    rect(10, 2, 1, 12, "paper", { opacity: 0.3 }),
    rect(3, 4, 8, 7, "paper"),
    rect(4, 5, 6, 5, "accent"),
    rect(12, 4, 1, 7, "paper"),
  ],
  stats: [
    rect(1, 14, 14, 1, "ink"),
    rect(2, 9, 3, 5, "tone"),
    rect(6, 5, 3, 9, "ink"),
    rect(10, 2, 3, 12, "accent"),
  ],
} as const satisfies Readonly<Record<string, Glyph>>;

export type IconName = keyof typeof ICON_GLYPHS;

function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICON_GLYPHS, name);
}

export const ICON_NAMES: ReadonlyArray<IconName> = Object.keys(ICON_GLYPHS).filter(isIconName);
