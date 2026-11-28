import type { LayerChange } from "@brr/domain";
import { BASE_LAYER_ID } from "@brr/schema/world";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { LAYER_SERVICE } from "../tokens.ts";

function layerService() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const layers = container.get(LAYER_SERVICE);
  const changes: LayerChange[] = [];
  layers.onEdit((change) => changes.push(change));
  return { layers, changes };
}

function created(result: ReturnType<ReturnType<typeof layerService>["layers"]["create"]>): number {
  if (!result.ok) throw new Error(`layer refused: ${JSON.stringify(result.issues)}`);
  return result.value;
}

describe("LayerService", () => {
  it("reports each edit once, by action and layer, with the tables before and after it", () => {
    const { layers, changes } = layerService();
    const track = created(layers.create("Track", "parts"));
    layers.rename(track, "Main line");
    layers.move(track, 0);
    layers.setVisible(track, false);
    layers.setVisible(track, true);
    layers.setLocked(track, true);
    layers.setLocked(track, false);
    layers.setOpacity(track, 35);

    expect(changes.map(({ action, layer }) => [action, layer])).toEqual([
      ["create", track],
      ["rename", track],
      ["move", track],
      ["hide", track],
      ["show", track],
      ["lock", track],
      ["unlock", track],
      ["opacity", track],
    ]);
    expect(changes.every((change, i) => i === 0 || change.before === changes[i - 1]?.after)).toBe(
      true,
    );
    expect(changes.at(-1)?.after).toBe(layers.table());
    expect(layers.table().layers.map(({ id, name, opacity }) => [id, name, opacity])).toEqual([
      [track, "Main line", 35],
      [BASE_LAYER_ID, "Parts", 100],
    ]);
  });

  it("reports nothing for an edit that changes nothing or is refused", () => {
    const { layers, changes } = layerService();

    expect(layers.setVisible(BASE_LAYER_ID, true)).toEqual([]);
    expect(layers.rename(BASE_LAYER_ID, " Parts ")).toEqual([]);
    expect(layers.rename(BASE_LAYER_ID, "  ")).not.toEqual([]);
    expect(layers.setOpacity(7, 50)).toEqual([
      { path: "layer 7", message: "isn't in the layer table" },
    ]);
    expect(changes).toEqual([]);
  });

  it("puts new parts on a layer just created for them, never on a notes or plan layer, and on the base layer once the active one is undone away", () => {
    const { layers, changes } = layerService();
    const track = created(layers.create("Track", "parts"));
    const labels = created(layers.create("Labels", "notes"));

    expect(layers.activeLayer()).toBe(track);
    expect(layers.setActiveLayer(labels)).toEqual([
      { path: `layer ${labels}`, message: "is a notes layer, and parts go on a parts layer" },
    ]);
    expect(layers.activeLayer()).toBe(track);
    layers.restore(changes[0]?.before ?? layers.table());
    expect(layers.activeLayer()).toBe(BASE_LAYER_ID);
  });

  it("says why nothing can be added to the active layer while it's locked or hidden", () => {
    const { layers } = layerService();
    const track = created(layers.create("Track", "parts"));

    expect(layers.activeLayerRefusal()).toBeNull();
    layers.setVisible(track, false);
    expect(layers.activeLayerRefusal()).toBe(
      'Layer "Track" is hidden, so nothing can be added to it.',
    );
    layers.setLocked(track, true);
    expect(layers.activeLayerRefusal()).toBe(
      'Layer "Track" is locked, so nothing can be added to it.',
    );
    expect(layers.setActiveLayer(BASE_LAYER_ID)).toEqual([]);
    expect(layers.activeLayerRefusal()).toBeNull();
  });
});
