import { expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fitGroundMap, type GroundMap, type GroundSample } from "./ground-map.ts";

export const STUD = 20;
export const TRACK_ITEM = "track:lego-9v";

const READY_TIMEOUT_MS = 150_000;
const STATS_SETTLE_MS = 1_500;
const SAMPLE_GRID = [-2, -1, 0, 1, 2] as const;
const SAMPLE_STEP_PX = 140;
const LOCAL_SAMPLES_PX = [-12, 0, 12] as const;
const SEEK_ATTEMPTS = 4;
const DRAG_STEPS = 10;
const QUARTER_TURNS = 4;
const SETTLED_STATUS = /^(?:ready|error)$/u;
const STUDS_META = /(\d+)×(\d+)/u;
const MODEL_IMPORT_TIMEOUT_MS = 180_000;
const GITHUB_RAW = "https://raw.githubusercontent.com/**";
const PINNED_LDRAW = new URL("../../../.cache/ldraw/", import.meta.url);
const HTTP_NOT_FOUND = 404;
const LDRAW_PATH = /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\/ldraw\/(?<path>.+)$/u;

export interface ScreenPoint {
  readonly sx: number;
  readonly sy: number;
}

export interface LatticePoint {
  readonly x: number;
  readonly z: number;
}

export interface Pose {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface PlanFootprint {
  readonly ref: string;
  readonly box: Box;
}

export interface TrackEnd {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly heading: number;
}

export interface ModelTrack {
  readonly pieces: number;
  readonly runFrame: number;
  readonly offField: number;
  readonly unanchored: number;
}

export interface PlayState {
  readonly status: string;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly bogiesOff: number;
  readonly derailSpeed: number;
}

export interface TrackCounts {
  readonly pieces: number;
  readonly openEnds: number;
  readonly joins: number;
  readonly lastCommit: string;
}

export interface ModelBake {
  readonly id: string;
  readonly lattice: unknown;
  readonly cells: unknown;
}

export interface ModelImport {
  readonly status: string;
  readonly item: string;
  readonly text: string;
}

export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly section: string;
}

interface PlacementColumns {
  readonly refId: ReadonlyArray<number>;
  readonly x: ReadonlyArray<number>;
  readonly z: ReadonlyArray<number>;
  readonly yPlates: ReadonlyArray<number>;
  readonly rot: ReadonlyArray<number>;
}

interface EditState {
  readonly world: {
    readonly refs: ReadonlyArray<string>;
    readonly placements: PlacementColumns;
    readonly trackEnds: ReadonlyArray<TrackEnd>;
    readonly bakes: ReadonlyArray<ModelBake>;
  };
}

interface PlanState {
  readonly placements: ReadonlyArray<PlanFootprint>;
  readonly tableTopY: number;
}

function column(values: ReadonlyArray<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`placement column has no row ${index}`);
  return value;
}

export function isStudAligned(ldu: number): boolean {
  return Number.isInteger(ldu / STUD);
}

export function byPosition(a: Pose, b: Pose): number {
  return a.x - b.x || a.z - b.z || a.yPlates - b.yPlates;
}

export class EditorPage {
  readonly root: Locator;
  private readonly canvas: Locator;
  private readonly samples: GroundSample[] = [];
  private map: GroundMap | null = null;

  private constructor(readonly page: Page) {
    this.root = page.locator(".editor");
    this.canvas = page.locator("canvas.scene");
  }

  static async open(page: Page, query = ""): Promise<EditorPage> {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?api=webgl2&state=1${query}`);
    const editor = new EditorPage(page);
    await expect(editor.root).toHaveAttribute("data-status", SETTLED_STATUS, {
      timeout: READY_TIMEOUT_MS,
    });
    const shown = await page.locator(".editor .error").allInnerTexts();
    expect(await editor.root.getAttribute("data-status"), [...shown, ...errors].join("\n")).toBe(
      "ready",
    );
    return editor;
  }

  private async settle(): Promise<void> {
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }

  async waitForFarTierAndMeshesSettled(): Promise<void> {
    await expect(this.root).not.toHaveAttribute("data-far-tier", "loading", {
      timeout: READY_TIMEOUT_MS,
    });
    await expect(this.root).toHaveAttribute("data-meshes", "settled", {
      timeout: READY_TIMEOUT_MS,
    });
    await this.settle();
  }

  async hud(label: string): Promise<string> {
    return this.page.evaluate((wanted) => {
      for (const row of document.querySelectorAll(".editor-hud dl > div")) {
        if (row.querySelector("dt")?.textContent === wanted) {
          return row.querySelector("dd")?.textContent ?? "";
        }
      }
      return "";
    }, label);
  }

  async steadyTriangles(): Promise<number> {
    let previous = -1;
    for (;;) {
      await this.page.waitForTimeout(STATS_SETTLE_MS);
      const triangles = Number((await this.hud("Drawn triangles")).replaceAll(",", ""));
      if (triangles > 0 && triangles === previous) return triangles;
      previous = triangles;
    }
  }

  private async canvasCentre(): Promise<ScreenPoint> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("the editor canvas is not laid out");
    return { sx: box.x + box.width / 2, sy: box.y + box.height / 2 };
  }

  private async onCanvas(point: ScreenPoint): Promise<boolean> {
    return this.page.evaluate(
      ({ sx, sy }) => document.elementFromPoint(sx, sy)?.matches("canvas.scene") ?? false,
      point,
    );
  }

  async hoverAt(point: ScreenPoint): Promise<LatticePoint | null> {
    await this.page.mouse.move(point.sx, point.sy);
    const value = await this.root.getAttribute("data-hover");
    if (!value) return null;
    const [x, z] = value.split(",").map(Number);
    if (x === undefined || z === undefined) throw new Error(`unreadable hover "${value}"`);
    return { x, z };
  }

  private async sample(point: ScreenPoint): Promise<void> {
    if (!(await this.onCanvas(point))) return;
    const hover = await this.hoverAt(point);
    if (hover) this.samples.push({ ...point, ...hover });
  }

  private async groundMap(): Promise<GroundMap> {
    if (this.map) return this.map;
    const centre = await this.canvasCentre();
    for (const gx of SAMPLE_GRID) {
      for (const gy of SAMPLE_GRID) {
        await this.sample({
          sx: centre.sx + gx * SAMPLE_STEP_PX,
          sy: centre.sy + gy * SAMPLE_STEP_PX,
        });
      }
    }
    this.map = fitGroundMap(this.samples);
    return this.map;
  }

  async screenOf(target: LatticePoint): Promise<ScreenPoint> {
    for (let attempt = 0; attempt < SEEK_ATTEMPTS; attempt++) {
      const point = (await this.groundMap()).screenOf(target.x, target.z);
      if (!(await this.onCanvas(point))) {
        throw new Error(`${target.x}, ${target.z} LDU is off screen or under a panel`);
      }
      const hover = await this.hoverAt(point);
      if (hover?.x === target.x && hover.z === target.z) return point;
      for (const dx of LOCAL_SAMPLES_PX) {
        for (const dy of LOCAL_SAMPLES_PX) {
          await this.sample({ sx: point.sx + dx, sy: point.sy + dy });
        }
      }
      this.map = fitGroundMap(this.samples);
    }
    throw new Error(`no screen point reads ${target.x}, ${target.z} LDU`);
  }

  private forgetView(): void {
    this.map = null;
    this.samples.length = 0;
  }

  async zoom(wheelDelta: number): Promise<void> {
    const centre = await this.canvasCentre();
    await this.page.mouse.move(centre.sx, centre.sy);
    await this.page.mouse.wheel(0, wheelDelta);
    await this.settle();
    this.forgetView();
  }

  async catalog(): Promise<ReadonlyArray<CatalogEntry>> {
    return this.page.locator(".palette [data-section] [data-item]").evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const id = button.getAttribute("data-item");
        const section = button.closest("[data-section]")?.getAttribute("data-section");
        const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
        return id && section ? [{ id, label, section }] : [];
      }),
    );
  }

  async choose(item: string): Promise<void> {
    await this.page.locator(`.palette [data-item="${item}"]`).click();
    await expect(this.page.locator(`.palette [data-item="${item}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  async escape(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.settle();
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.settle();
  }

  async clickAt(target: LatticePoint): Promise<void> {
    const point = await this.screenOf(target);
    await this.page.mouse.click(point.sx, point.sy);
    await this.settle();
  }

  async turnGhostTo(rot: number): Promise<void> {
    for (let turn = 0; turn < QUARTER_TURNS; turn++) {
      if ((await this.root.getAttribute("data-ghost-rot")) === String(rot)) return;
      await this.press("r");
    }
    throw new Error(`the ghost never reached rotation ${rot}`);
  }

  async aim(item: string, target: LatticePoint, rot = 0): Promise<ScreenPoint> {
    await this.escape();
    const point = await this.screenOf(target);
    await this.choose(item);
    await this.turnGhostTo(rot);
    expect(await this.hoverAt(point), `${item} is aimed at ${target.x}, ${target.z}`).toEqual({
      x: target.x,
      z: target.z,
    });
    return point;
  }

  async dragOnto(source: Locator, point: ScreenPoint): Promise<void> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("the editor canvas is not laid out");
    await source.dragTo(this.canvas, {
      targetPosition: { x: point.sx - box.x, y: point.sy - box.y },
    });
    await this.settle();
  }

  async placeAt(item: string, target: LatticePoint, rot = 0): Promise<void> {
    const point = await this.aim(item, target, rot);
    await this.page.mouse.click(point.sx, point.sy);
    await this.settle();
  }

  async select(target: LatticePoint): Promise<string> {
    await this.escape();
    await this.clickAt(target);
    return (await this.root.getAttribute("data-selection")) ?? "";
  }

  async undo(): Promise<void> {
    await this.press("Control+z");
  }

  async redo(): Promise<void> {
    await this.press("Control+Shift+z");
  }

  async itemStuds(item: string): Promise<{ readonly wide: number; readonly deep: number }> {
    const meta = await this.page
      .locator(`.palette [data-item="${item}"]`)
      .evaluate(
        (button) =>
          button.querySelector(".catalog-meta")?.textContent ??
          button.closest(".palette-row")?.querySelector(".palette-size")?.textContent ??
          "",
      );
    const match = STUDS_META.exec(meta);
    if (!match) throw new Error(`the palette gives no stud size for ${item}: "${meta}"`);
    return { wide: Number(match[1]), deep: Number(match[2]) };
  }

  async snapState(): Promise<string> {
    return (await this.root.getAttribute("data-snap-state")) ?? "";
  }

  async dragTrack(from: LatticePoint, to: LatticePoint): Promise<TrackCounts> {
    const a = await this.screenOf(from);
    const b = await this.screenOf(to);
    await this.page.mouse.move(a.sx, a.sy);
    await this.settle();
    await this.page.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const t = step / DRAG_STEPS;
      await this.page.mouse.move(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t);
    }
    await this.page.mouse.up();
    await this.settle();
    return this.trackCounts();
  }

  async strokeTrack(points: ReadonlyArray<LatticePoint>): Promise<TrackCounts> {
    const [first, ...rest] = points;
    if (!first) throw new Error("a stroke has at least one point");
    const start = await this.screenOf(first);
    const map = await this.groundMap();
    await this.page.mouse.move(start.sx, start.sy);
    await this.settle();
    await this.page.mouse.down();
    for (const point of rest) {
      const at = map.screenOf(point.x, point.z);
      await this.page.mouse.move(at.sx, at.sy);
    }
    await this.page.mouse.up();
    await this.settle();
    return this.trackCounts();
  }

  async toolHint(): Promise<string> {
    return (await this.page.locator(".tool-hud").innerText()).replaceAll("\n", " ");
  }

  async trackCounts(): Promise<TrackCounts> {
    const panel = this.page.locator("section.track-panel");
    const read = async (name: string): Promise<string> =>
      (await panel.getAttribute(`data-${name}`)) ?? "";
    return {
      pieces: Number(await read("track-pieces")),
      openEnds: Number(await read("open-ends")),
      joins: Number(await read("joins")),
      lastCommit: await read("last-commit"),
    };
  }

  async modelTrack(): Promise<ModelTrack> {
    const panel = this.page.locator("section.track-panel");
    return {
      pieces: Number(await panel.getAttribute("data-model-pieces")),
      runFrame: Number(await panel.getAttribute("data-run-frame-pieces")),
      offField: Number(await panel.getAttribute("data-off-field")),
      unanchored: Number(await panel.getAttribute("data-unanchored")),
    };
  }

  async startPlay(): Promise<void> {
    await this.page.keyboard.press("Shift+P");
    await this.page.waitForSelector('section.play-panel[data-play-status="running"]');
  }

  async playState(): Promise<PlayState> {
    const panel = this.page.locator("section.play-panel");
    const read = async (name: string): Promise<string> =>
      (await panel.getAttribute(`data-${name}`)) ?? "";
    return {
      status: await read("play-status"),
      xLdu: Number(await read("train-x")),
      zLdu: Number(await read("train-z")),
      bogiesOff: Number(await read("bogies-off")),
      derailSpeed: Number(await read("derail-speed")),
    };
  }

  private async editState(): Promise<EditState> {
    const text = await this.page.locator("#edit-state").textContent();
    if (!text) throw new Error("the editor state dump is empty; open the editor with state=1");
    const parsed: EditState = JSON.parse(text);
    return parsed;
  }

  async serveLdrawLibrary(): Promise<void> {
    await this.page.context().route(GITHUB_RAW, async (route) => {
      const path = LDRAW_PATH.exec(decodeURIComponent(new URL(route.request().url()).pathname))
        ?.groups?.["path"];
      const text =
        path === undefined
          ? undefined
          : await readFile(new URL(path, PINNED_LDRAW), "utf8").catch(() => undefined);
      await (text === undefined
        ? route.fulfill({ status: HTTP_NOT_FOUND })
        : route.fulfill({ status: 200, body: text }));
    });
  }

  async importModel(file: string): Promise<ModelImport> {
    await this.page.locator("input.model-file-import").setInputFiles(file);
    const name = basename(file);
    const status = this.page.locator(
      `.model-import[data-file="${name}"]:not([data-status="importing"])`,
    );
    await expect(status).toHaveCount(1, { timeout: MODEL_IMPORT_TIMEOUT_MS });
    return {
      status: (await status.getAttribute("data-status")) ?? "",
      item: (await status.getAttribute("data-item")) ?? "",
      text: (await status.locator("p").first().textContent()) ?? "",
    };
  }

  async bakes(): Promise<ReadonlyArray<ModelBake>> {
    return (await this.editState()).world.bakes;
  }

  async poses(): Promise<ReadonlyArray<Pose>> {
    const { world } = await this.editState();
    const { placements, refs } = world;
    return placements.refId
      .map((refId, i) => ({
        item: refs[refId] ?? `unknown ref ${refId}`,
        x: column(placements.x, i),
        z: column(placements.z, i),
        yPlates: column(placements.yPlates, i),
        rot: column(placements.rot, i),
      }))
      .toSorted(byPosition);
  }

  async trackEnds(): Promise<ReadonlyArray<TrackEnd>> {
    return (await this.editState()).world.trackEnds;
  }

  private async planState(): Promise<PlanState> {
    const text = await this.page.locator("#plan-state").textContent();
    if (!text) throw new Error("the plan state dump is empty; open the editor with state=1");
    const parsed: PlanState = JSON.parse(text);
    return parsed;
  }

  async footprints(): Promise<ReadonlyArray<PlanFootprint>> {
    return (await this.planState()).placements;
  }

  async tableTopY(): Promise<number> {
    return (await this.planState()).tableTopY;
  }

  async counter(
    name:
      | "refused"
      | "road-joined"
      | "road-open"
      | "road-mismatch"
      | "module-joined"
      | "module-open"
      | "module-mismatch",
  ): Promise<number> {
    return Number(await this.root.getAttribute(`data-${name}`));
  }
}

export function nearestLattice(end: TrackEnd): LatticePoint {
  return {
    x: Math.round(end.xLdu / STUD) * STUD,
    z: Math.round(end.zLdu / STUD) * STUD,
  };
}
