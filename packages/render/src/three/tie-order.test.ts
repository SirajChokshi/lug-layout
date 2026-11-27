import { Group, Object3D } from "three/webgpu";
import { expect, it } from "vitest";
import {
  KeyOrderedChildren,
  opaqueSort,
  transparentSort,
  type RenderSortKey,
} from "./tie-order.ts";

function item(groupOrder: number, renderOrder: number, z: number): RenderSortKey {
  return { groupOrder, renderOrder, z };
}

function named(name: string): Object3D {
  const object = new Object3D();
  object.name = name;
  return object;
}

function childNames(parent: Object3D): string[] {
  return (parent.children[0]?.children ?? []).map((child) => child.name);
}

it("sorts by group order, then render order, then depth: nearest first when opaque, farthest first when transparent", () => {
  const pairs: ReadonlyArray<readonly [RenderSortKey, RenderSortKey]> = [
    [item(0, 0, 9), item(1, 0, 1)],
    [item(0, 0, 9), item(0, 2, 1)],
    [item(0, 0, 1), item(0, 0, 2)],
  ];

  expect(
    pairs.map(([a, b]) => [Math.sign(opaqueSort(a, b)), Math.sign(transparentSort(a, b))]),
  ).toEqual([
    [-1, -1],
    [-1, -1],
    [-1, 1],
  ]);
});

const SORT_KEY_VALUES: ReadonlyArray<number | null> = [
  null,
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  -1,
  -0,
  0,
  Number.MIN_VALUE,
  0.5,
  1,
  Number.POSITIVE_INFINITY,
];

function signOfSubtraction(a: number | null, b: number | null): number {
  return Math.sign((a ?? 0) - (b ?? 0)) || 0;
}

function subtractionOrder(a: RenderSortKey, b: RenderSortKey, depthAscending: boolean): number {
  if (a.groupOrder !== b.groupOrder) return signOfSubtraction(a.groupOrder, b.groupOrder);
  if (a.renderOrder !== b.renderOrder) return signOfSubtraction(a.renderOrder, b.renderOrder);
  if (a.z === b.z) return 0;
  return depthAscending ? signOfSubtraction(a.z, b.z) : signOfSubtraction(b.z, a.z);
}

it("answers only -1, 0 or 1, with the sign of the keys' subtraction, for every key the sort can see, NaN, ±0, ±Infinity and null included", () => {
  const keys: RenderSortKey[] = [];
  for (const groupOrder of SORT_KEY_VALUES) {
    for (const renderOrder of SORT_KEY_VALUES) {
      for (const z of SORT_KEY_VALUES) keys.push({ groupOrder, renderOrder, z });
    }
  }
  const mismatches: string[] = [];
  for (const a of keys) {
    for (const b of keys) {
      const opaque = opaqueSort(a, b);
      const transparent = transparentSort(a, b);
      if (
        !Object.is(opaque, subtractionOrder(a, b, true)) ||
        !Object.is(transparent, subtractionOrder(a, b, false))
      ) {
        mismatches.push(JSON.stringify([a, b, opaque, transparent]));
      }
    }
  }

  expect({ pairs: keys.length ** 2, mismatches: mismatches.slice(0, 5) }).toEqual({
    pairs: 1_000_000,
    mismatches: [],
  });
});

it("keeps children in key order whatever order they are added in", () => {
  const ascending = new Group();
  const shuffled = new Group();
  const inOrder = new KeyOrderedChildren(ascending);
  const outOfOrder = new KeyOrderedChildren(shuffled);

  for (const key of [1, 5, 9]) inOrder.add(named(`k${key}`), key);
  for (const key of [9, 1, 5]) outOfOrder.add(named(`k${key}`), key);

  expect([childNames(ascending), childNames(shuffled)]).toEqual([
    ["k1", "k5", "k9"],
    ["k1", "k5", "k9"],
  ]);
});

it("keeps the rest in order when a child is removed, and puts a re-added key back in its place", () => {
  const parent = new Group();
  const children = new KeyOrderedChildren(parent);
  const middle = named("k5");
  children.add(named("k1"), 1);
  children.add(middle, 5);
  children.add(named("k9"), 9);

  children.remove(middle);
  const afterRemove = childNames(parent);
  children.add(named("k5 again"), 5);

  expect([afterRemove, childNames(parent)]).toEqual([
    ["k1", "k9"],
    ["k1", "k5 again", "k9"],
  ]);
});

it("refuses a key or a child it already holds, without changing anything", () => {
  const parent = new Group();
  const children = new KeyOrderedChildren(parent);
  const first = named("k1");
  children.add(first, 1);
  children.add(named("k5"), 5);

  expect(() => children.add(named("another k1"), 1)).toThrow("key or child already held");
  expect(() => children.add(first, 3)).toThrow("key or child already held");
  expect(childNames(parent)).toEqual(["k1", "k5"]);
});

it("empties on clear", () => {
  const parent = new Group();
  const children = new KeyOrderedChildren(parent);
  children.add(named("k1"), 1);

  children.clear();

  expect([parent.children.length, childNames(parent)]).toEqual([1, []]);
});
