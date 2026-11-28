import { expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { BlueBrickMap } from "./index.ts";

interface Ref {
  readonly layer: number;
  readonly brick: number;
}

interface ConnectionRef extends Ref {
  readonly connection: number;
}

const BLACK = { kind: "named", name: "Black" } as const;
const FONT = {
  family: "Arial",
  size: 8,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
};
const AREA = { x: "8", y: "12", width: "16", height: "8" };

function piece(id: string, connections: ReadonlyArray<object>, group: number | null) {
  return {
    id,
    part: "53401.72",
    area: AREA,
    orientation: "-22.5",
    altitude: "0",
    activeConnection: 0,
    group,
    connections,
  };
}

function fixture() {
  const forward = {
    id: "100",
    link: { layer: 0, brick: 1, connection: 0 } as ConnectionRef | null,
  };
  const free = { id: "101", link: null as ConnectionRef | null };
  const backward = {
    id: "110",
    link: { layer: 0, brick: 0, connection: 0 } as ConnectionRef | null,
  };
  const first = piece("10", [forward, free], 0);
  const second = piece("11", [backward], null);
  const root = { id: "41", part: "YARD-LEAD.KIT", parent: null as number | null };
  const track = {
    id: "1",
    name: "Track",
    visible: true,
    opacity: 100,
    hull: null,
    kind: "brick",
    showElevation: false,
    bricks: [first, second],
    groups: [{ id: "40", part: null, parent: 1 }, root],
  };
  const ruler = {
    area: AREA,
    group: null,
    color: BLACK,
    lineThickness: 1,
    showDistance: true,
    showUnit: true,
    guideline: { color: BLACK, thickness: 1, dashPattern: [2, 4] },
    unit: "stud",
    measureFont: FONT,
    measureColor: BLACK,
    shape: "circular",
    center: { x: "16", y: "16" },
    radius: "12",
    attachment: { layer: 0, brick: 1 } as Ref,
  };
  const measures = {
    id: "2",
    name: "Measures",
    visible: true,
    opacity: 100,
    hull: null,
    kind: "ruler",
    rulers: [ruler],
    groups: [],
  };
  const issues: object[] = [
    { kind: "skippedLayer", position: 0, layerType: "flex" },
    { kind: "danglingLink", from: { layer: 0, brick: 0, connection: 1 }, target: "999" },
  ];
  const map = {
    version: 9,
    properties: {
      author: "a",
      lug: "l",
      event: "e",
      date: { year: 2026, month: 11, day: 27 },
      comment: "",
      background: null,
    },
    layers: [track, measures],
    issues,
  };
  return { map, track, first, second, free, backward, root, ruler, issues };
}

type Fixture = ReturnType<typeof fixture>;

function messages(map: unknown): ReadonlyArray<string> {
  const decoded = decode(BlueBrickMap, map);
  return decoded.ok ? [] : decoded.issues.map((issue) => issue.message);
}

const LINKS =
  "every connection link names another connection on a brick layer that links back to it";
const GROUPS =
  "every group membership and parent names a group of the same layer, and no group is its own ancestor";

it("accepts a map whose links, groups, attachments and issues all name what it holds", () => {
  expect(messages(fixture().map)).toEqual([]);
});

it.each<[string, (held: Fixture) => void, string]>([
  [
    "a link the other connection doesn't return",
    (held) => {
      held.backward.link = null;
    },
    LINKS,
  ],
  [
    "a connection linked to itself",
    (held) => {
      held.free.link = { layer: 0, brick: 0, connection: 1 };
    },
    LINKS,
  ],
  [
    "a group that is its own ancestor",
    (held) => {
      held.root.parent = 0;
    },
    GROUPS,
  ],
  [
    "a brick in a group its layer doesn't have",
    (held) => {
      held.second.group = 2;
    },
    GROUPS,
  ],
  [
    "a ruler attached to a layer that holds no bricks",
    (held) => {
      held.ruler.attachment = { layer: 1, brick: 0 };
    },
    "every ruler attachment names a brick on a brick layer",
  ],
  [
    "an issue about a connection the map doesn't have",
    (held) => {
      held.issues[1] = {
        kind: "danglingLink",
        from: { layer: 0, brick: 1, connection: 1 },
        target: "999",
      };
    },
    "every read issue names layers, bricks, connections, groups and rulers the map has",
  ],
  [
    "a decimal not written canonically",
    (held) => {
      held.first.orientation = "-22.50";
    },
    "must be an exact decimal written canonically",
  ],
  [
    "an id with leading zeros",
    (held) => {
      held.track.id = "007";
    },
    "must be a whole number written canonically",
  ],
])("refuses %s", (_, corrupt, message) => {
  const held = fixture();
  corrupt(held);
  expect(messages(held.map)).toEqual([message]);
});
