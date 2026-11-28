import type { HoverMateCount, PlacementHover, PlacementMode } from "@brr/client";
import type { FetchFunction } from "@brr/import";
import { expect, type Locator, type Page } from "@playwright/test";
import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fitGroundMap, type GroundMap, type GroundSample } from "./ground-map.ts";
import { ServedBake } from "./served-bake.ts";
import { UsersOwnParts } from "./users-own-parts.ts";

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
const HOVER_SETTLE_TIMEOUT_MS = 5_000;
const GITHUB_RAW = "https://raw.githubusercontent.com/**";
const PINNED_LDRAW = new URL("../../../.cache/ldraw/", import.meta.url);
const HTTP_NOT_FOUND = 404;
const PLACEABLE = "placeable";

function pinnedLdrawPath(url: string): string | undefined {
  return LDRAW_PATH.exec(decodeURIComponent(new URL(url).pathname))?.groups?.["path"];
}

export function pinnedLdrawFetch(): FetchFunction {
  return async (url) => {
    const path = pinnedLdrawPath(url);
    const bytes =
      path === undefined ? null : await readFile(new URL(path, PINNED_LDRAW)).catch(() => null);
    return bytes === null ? new Response(null, { status: HTTP_NOT_FOUND }) : new Response(bytes);
  };
}
const LDRAW_PATH = /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\/ldraw\/(?<path>.+)$/u;
const LIBRARY_FOLDERS = ["p/8/", "p/48/", "parts/", "p/"] as const;
const BUNDLE_MODEL_RECORD = /\/standard\/model-[^/]+\.json$/u;

export interface RawLibrary {
  served(): number;
}

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

export interface LaidTrackPiece {
  readonly index: number;
  readonly ref: string;
  readonly heading: number;
  readonly position: ReadonlyArray<string>;
  readonly yPlates: number;
  readonly layer?: number;
}

export interface LayeredContents {
  readonly placements: ReadonlyArray<string>;
  readonly track: ReadonlyArray<number>;
}

export interface TrackChoice {
  readonly kind: string;
  readonly pieces: number;
  readonly joins: boolean;
}

export interface LoopOffer {
  readonly pieces: number;
  readonly label: string;
  readonly text: string;
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
  readonly layer: ReadonlyArray<number>;
}

export interface TrackRoute {
  readonly from: TrackEnd;
  readonly to: TrackEnd;
}

export interface CrossingRamp {
  readonly part: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rot: number;
  readonly studMates: number;
}

export interface LevelCrossing {
  readonly tracks: ReadonlyArray<number>;
  readonly roads: ReadonlyArray<number>;
  readonly roadwayCells: number;
  readonly ramps: ReadonlyArray<CrossingRamp>;
}

export interface DumpedMateCount extends Omit<HoverMateCount, "jointIds"> {
  readonly jointIds: ReadonlyArray<number>;
}

export interface DumpedPlacementHover extends Omit<PlacementHover, "mates" | "turnMates"> {
  readonly mates: ReadonlyArray<DumpedMateCount>;
  readonly turnMates: ReadonlyArray<DumpedMateCount>;
}

export interface HoverState {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly placement: DumpedPlacementHover | null;
}

interface EditState {
  readonly placementMode: PlacementMode;
  readonly placementModeOverride: boolean;
  readonly hover: HoverState | null;
  readonly world: {
    readonly covers: ReadonlyArray<{ readonly id: string }>;
    readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
    readonly refs: ReadonlyArray<string>;
    readonly placements: PlacementColumns;
    readonly laidTrack: ReadonlyArray<LaidTrackPiece>;
    readonly trackEnds: ReadonlyArray<TrackEnd>;
    readonly bakes: ReadonlyArray<ModelBake>;
    readonly studChecks: number;
    readonly crossings: ReadonlyArray<LevelCrossing>;
  };
  readonly routes: ReadonlyArray<TrackRoute>;
}

export interface PlanRect {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

export interface PlanRegion {
  readonly id: string;
  readonly name: string;
  readonly originChunkX: number;
  readonly originChunkZ: number;
  readonly maxOverhangMm: number;
  readonly maxReachMm: number;
  readonly footprint: {
    readonly roomWidthMm: number;
    readonly roomDepthMm: number;
    readonly tables: ReadonlyArray<{
      readonly id: string;
      readonly number: number;
      readonly name: string;
      readonly rect: PlanRect;
      readonly heightMm: number;
      readonly typeId?: number;
    }>;
    readonly obstacles: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly rect: PlanRect;
    }>;
  };
}

export interface PlanRow {
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
}

interface PlanState {
  readonly plans: ReadonlyArray<PlanRegion>;
  readonly placements: ReadonlyArray<PlanFootprint>;
  readonly tableTopY: number;
  readonly checks: ReadonlyArray<{ readonly issues: ReadonlyArray<PlanRow> }>;
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

export async function startEmpty(page: Page): Promise<void> {
  const welcome = page.locator(".welcome");
  if ((await welcome.count()) === 0) return;
  await welcome.locator('[data-action="start-empty"]').click();
  await expect(welcome).toHaveCount(0);
}

const Z_COEFFICIENT = 4;

export function shiftedPosition(position: ReadonlyArray<string>, dx: number, dz: number): string[] {
  return position.map((coefficient, k) => {
    const shift = k === 0 ? dx : k === Z_COEFFICIENT ? dz : 0;
    return (BigInt(coefficient) + BigInt(shift / STUD)).toString();
  });
}

function libraryReference(path: string): string {
  const folder = LIBRARY_FOLDERS.find((candidate) => path.startsWith(candidate));
  return folder === undefined ? path : path.slice(folder.length);
}

async function pinned(path: string): Promise<boolean> {
  return access(new URL(path, PINNED_LDRAW)).then(
    () => true,
    () => false,
  );
}

async function unpinnedReference(path: string): Promise<string | null> {
  const reference = libraryReference(path);
  const places = [reference, ...LIBRARY_FOLDERS.map((folder) => `${folder}${reference}`)];
  const held = await Promise.all(places.map(pinned));
  return held.includes(true) ? null : reference;
}

export class EditorPage {
  readonly root: Locator;
  private readonly canvas: Locator;
  private readonly stateDump: Locator;
  private readonly samples: GroundSample[] = [];
  private map: GroundMap | null = null;

  private constructor(
    readonly page: Page,
    private readonly bake: ServedBake,
  ) {
    this.root = page.locator(".editor");
    this.canvas = page.locator("canvas.scene");
    this.stateDump = page.locator("#edit-state");
  }

  static async open(page: Page, query = ""): Promise<EditorPage> {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bake = await ServedBake.install(page.context());
    await page.goto(`/?api=webgl2&state=1${query}`);
    const editor = new EditorPage(page, bake);
    await expect(editor.root).toHaveAttribute("data-status", SETTLED_STATUS, {
      timeout: READY_TIMEOUT_MS,
    });
    const shown = await page.locator(".editor .error").allInnerTexts();
    expect(await editor.root.getAttribute("data-status"), [...shown, ...errors].join("\n")).toBe(
      "ready",
    );
    await startEmpty(page);
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

  async saved(): Promise<void> {
    await expect(this.root).toHaveAttribute("data-unsaved", "0");
    await expect(this.root).toHaveAttribute("data-save", "saved");
  }

  async reload(): Promise<void> {
    await this.page.reload();
    await expect(this.root).toHaveAttribute("data-status", SETTLED_STATUS, {
      timeout: READY_TIMEOUT_MS,
    });
    expect(await this.root.getAttribute("data-status")).toBe("ready");
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

  private async viewAtRest(): Promise<void> {
    await expect
      .poll(
        () =>
          this.page.evaluate(
            () =>
              new Promise<boolean>((resolve) => {
                const dump = document.getElementById("camera-state");
                const before = dump?.textContent ?? "";
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() =>
                      resolve(before !== "" && dump?.textContent === before),
                    ),
                  ),
                );
              }),
          ),
        { message: "the camera's view holds still across consecutive frames" },
      )
      .toBe(true);
  }

  async goTo(target: LatticePoint): Promise<void> {
    await this.page.getByLabel("Go to x (LDU)").fill(String(target.x));
    await this.page.getByLabel("Go to z (LDU)").fill(String(target.z));
    await this.page.getByRole("button", { name: "Go to x, z" }).click();
    await this.settle();
    this.forgetView();
  }

  async zoomAt(target: LatticePoint, wheelDelta: number): Promise<void> {
    const point = await this.screenOf(target);
    await this.page.mouse.move(point.sx, point.sy);
    await this.page.mouse.wheel(0, wheelDelta);
    await this.viewAtRest();
    this.forgetView();
  }

  async zoom(wheelDelta: number): Promise<void> {
    const centre = await this.canvasCentre();
    await this.page.mouse.move(centre.sx, centre.sy);
    await this.page.mouse.wheel(0, wheelDelta);
    await this.viewAtRest();
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

  async pick(item: string): Promise<void> {
    const button = this.page.locator(`.palette [data-item="${item}"]`);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }

  async choose(item: string): Promise<void> {
    await this.pick(item);
    await expect(this.stateDump).not.toHaveAttribute("data-held-tables", "loading");
  }

  async heldTables(): Promise<string | null> {
    return this.stateDump.getAttribute("data-held-tables");
  }

  async toolHud(): Promise<string> {
    return (await this.page.locator(".tool-hud").textContent()) ?? "";
  }

  async holdModelRecords(): Promise<() => void> {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await this.page.route(
      (url) => BUNDLE_MODEL_RECORD.test(url.pathname),
      async (route) => {
        await released;
        await route.continue();
      },
    );
    return release;
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

  async dragFrom(from: LatticePoint, ...through: ReadonlyArray<LatticePoint>): Promise<void> {
    const points = [await this.screenOf(from)];
    for (const target of through) points.push(await this.screenOf(target));
    const [start] = points;
    if (!start) throw new Error("a drag needs a start");
    await this.page.mouse.move(start.sx, start.sy);
    await this.settle();
    await this.page.mouse.down();
    for (let leg = 1; leg < points.length; leg++) {
      const a = points[leg - 1] ?? start;
      const b = points[leg] ?? start;
      for (let step = 1; step <= DRAG_STEPS; step++) {
        const t = step / DRAG_STEPS;
        await this.page.mouse.move(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t);
      }
    }
    await this.settle();
    await this.page.mouse.up();
    await this.settle();
  }

  async shiftClickAt(target: LatticePoint): Promise<void> {
    const point = await this.screenOf(target);
    await this.page.keyboard.down("Shift");
    await this.page.mouse.click(point.sx, point.sy);
    await this.page.keyboard.up("Shift");
    await this.settle();
  }

  async doubleClickAt(target: LatticePoint, modifier: "Shift" | null = null): Promise<void> {
    const point = await this.screenOf(target);
    const view = await this.cameraView();
    if (modifier) await this.page.keyboard.down(modifier);
    await this.page.mouse.dblclick(point.sx, point.sy);
    if (modifier) await this.page.keyboard.up(modifier);
    await this.settle();
    await this.viewAtRest();
    if ((await this.cameraView()) !== view) this.forgetView();
  }

  async cameraView(): Promise<string> {
    return (await this.page.locator("#camera-state").textContent()) ?? "";
  }

  async selectionCount(): Promise<number> {
    return Number(await this.root.getAttribute("data-selection-count"));
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

  async trackChoice(): Promise<TrackChoice | null> {
    const strip = this.page.locator("section.track-extend-panel .track-extend");
    if ((await strip.count()) === 0) return null;
    return {
      kind: (await strip.getAttribute("data-choice")) ?? "",
      pieces: Number(await strip.getAttribute("data-choice-pieces")),
      joins: (await strip.getAttribute("data-choice-joins")) === "true",
    };
  }

  private loopsPanel(): Locator {
    return this.page.locator("section.track-loops-panel");
  }

  async loopOffers(): Promise<ReadonlyArray<LoopOffer>> {
    const panel = this.loopsPanel();
    await expect
      .poll(
        async () => [
          await panel.getAttribute("data-scanning"),
          await panel.getAttribute("data-waiting"),
        ],
        { timeout: READY_TIMEOUT_MS },
      )
      .toEqual(["false", "0"]);
    return panel.locator("li").evaluateAll((rows) =>
      rows.map((row) => ({
        pieces: Number(row.getAttribute("data-pieces")),
        label: row.querySelector("button")?.textContent ?? "",
        text: row.querySelector("p")?.textContent ?? "",
      })),
    );
  }

  async previewLoop(index: number): Promise<void> {
    await this.loopsPanel().locator("li button").nth(index).hover();
    await this.settle();
  }

  async closeLoop(index: number): Promise<TrackCounts> {
    await this.loopsPanel().locator("li button").nth(index).click();
    await this.settle();
    return this.trackCounts();
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
    const dump = this.page.locator("#edit-state");
    const read = async (): Promise<EditState> => {
      const text = await dump.textContent();
      if (!text) throw new Error("the editor state dump is empty; open the editor with state=1");
      const parsed: EditState = JSON.parse(text);
      return parsed;
    };
    await expect
      .poll(async () => (await read()).world.studChecks, { timeout: MODEL_IMPORT_TIMEOUT_MS })
      .toBe(0);
    return read();
  }

  async serveLdrawLibrary(): Promise<RawLibrary> {
    let served = 0;
    const usersOwnParts = UsersOwnParts.of(this.page.context());
    const reported = new Set<string>();
    await this.page.context().route(GITHUB_RAW, async (route) => {
      const url = route.request().url();
      const path = pinnedLdrawPath(url);
      const text =
        path === undefined
          ? undefined
          : await readFile(new URL(path, PINNED_LDRAW), "utf8").catch(() => undefined);
      if (text !== undefined) {
        served += 1;
        await route.fulfill({ status: 200, body: text });
        return;
      }
      const missing = path === undefined ? url : await unpinnedReference(path);
      if (missing !== null && !usersOwnParts.has(missing) && !reported.has(missing)) {
        reported.add(missing);
        expect
          .soft(false, `the editor asked for ${path ?? url}, which .cache/ldraw doesn't hold`)
          .toBe(true);
      }
      await route.fulfill({ status: HTTP_NOT_FOUND });
    });
    return { served: () => served };
  }

  blockLibraryBake(): () => void {
    return this.bake.block();
  }

  async importModel(file: string): Promise<ModelImport> {
    await UsersOwnParts.of(this.page.context()).learn(file);
    await this.page.locator("input.model-file-import").setInputFiles(file);
    return this.importOutcome(basename(file));
  }

  async importLayout(file: string): Promise<ModelImport> {
    await UsersOwnParts.of(this.page.context()).learn(file);
    await this.page.locator("input.layout-file-import").setInputFiles(file);
    return this.importOutcome(basename(file));
  }

  async openPlanFile(file: string): Promise<void> {
    await UsersOwnParts.of(this.page.context()).learn(file);
    await this.page
      .locator('input[aria-label="Open a .brrplan.zip plan file"]')
      .setInputFiles(file);
  }

  private async importOutcome(name: string): Promise<ModelImport> {
    const status = this.page.locator(
      `.model-import[data-file="${name}"]:not([data-status="importing"]):not([data-status="checking"])`,
    );
    await expect(status).toHaveCount(1, { timeout: MODEL_IMPORT_TIMEOUT_MS });
    if ((await status.getAttribute("data-status")) === PLACEABLE) this.bake.expectIndexServed();
    return {
      status: (await status.getAttribute("data-status")) ?? "",
      item: (await status.getAttribute("data-item")) ?? "",
      text: (await status.locator("p").first().textContent()) ?? "",
    };
  }

  async searchPalette(query: string): Promise<void> {
    await this.page.locator(".palette-search").fill(query);
    await expect(this.page.locator(".palette-library")).toHaveAttribute(
      "data-library-status",
      "ready",
      { timeout: READY_TIMEOUT_MS },
    );
  }

  async libraryParts(): Promise<ReadonlyArray<string>> {
    return this.page
      .locator(".palette-library [data-library-part]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-library-part") ?? ""));
  }

  async pickLibraryPart(part: string, color: number): Promise<ModelImport> {
    const swatch = this.page.locator(`.palette-library [data-library-item="${part}@${color}"]`);
    const partInColor = await swatch.getAttribute("aria-label");
    if (partInColor === null) throw new Error(`the library offers no ${part} in colour ${color}`);
    await swatch.click();
    return this.importOutcome(`${part} ${partInColor}.ldr`);
  }

  async refs(): Promise<ReadonlyArray<string>> {
    return (await this.editState()).world.refs;
  }

  async hoverPlacement(): Promise<DumpedPlacementHover | null> {
    return (await this.editState()).hover?.placement ?? null;
  }

  async hoverState(): Promise<HoverState | null> {
    return (await this.editState()).hover;
  }

  async hoverIn(mode: PlacementMode): Promise<HoverState> {
    await expect
      .poll(async () => (await this.hoverPlacement())?.mode ?? null, {
        message: `the hover is evaluated in ${mode} mode`,
      })
      .toBe(mode);
    const aimed = await this.hoverState();
    await expect
      .poll(
        async () => {
          const placement = await this.hoverPlacement();
          if (!placement) return "no placement hover";
          return [
            ...(placement.settled ? [] : ["settled"]),
            ...(placement.turnSettled ? [] : ["turnSettled"]),
          ].join(" and ");
        },
        {
          message: `the ${mode} hover at cell (${aimed?.x}, ${aimed?.z}) settles within ${HOVER_SETTLE_TIMEOUT_MS} ms; received names the flags still false`,
          timeout: HOVER_SETTLE_TIMEOUT_MS,
        },
      )
      .toBe("");
    const hover = await this.hoverState();
    if (!hover?.placement) throw new Error(`no placement hover in ${mode} mode`);
    return hover;
  }

  placementSwitch(): Locator {
    return this.page.getByRole("switch", { name: "Precise placement" });
  }

  async placementModes(): Promise<{
    readonly mode: PlacementMode;
    readonly override: boolean;
  }> {
    const state = await this.editState();
    return { mode: state.placementMode, override: state.placementModeOverride };
  }

  async hoverPlacementAt(item: string, target: LatticePoint): Promise<ScreenPoint> {
    await this.escape();
    const point = await this.screenOf(target);
    await this.choose(item);
    await this.page.mouse.move(point.sx, point.sy);
    await expect
      .poll(() => this.hoverPlacement(), { message: `${item} has a placement hover` })
      .not.toBeNull();
    return point;
  }

  async frameShift(item: string): Promise<readonly [number, number, number]> {
    const { world } = await this.editState();
    const index = world.covers.findIndex(
      (cover) => item === cover.id || item.startsWith(`${cover.id}@`),
    );
    const shift = world.frameShifts[index];
    if (index < 0 || !shift) throw new Error(`${item} has no loaded placeable`);
    return shift;
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

  async layered(): Promise<LayeredContents> {
    const { world } = await this.editState();
    const { placements, refs, laidTrack } = world;
    return {
      placements: placements.refId
        .map((refId, i) => `${refs[refId] ?? refId} on ${column(placements.layer, i)}`)
        .toSorted(),
      track: laidTrack.map((piece) => piece.layer ?? 0).toSorted((a, b) => a - b),
    };
  }

  async crossings(): Promise<ReadonlyArray<LevelCrossing>> {
    return (await this.editState()).world.crossings;
  }

  async unsupportedTrack(): Promise<number> {
    const panel = this.page.locator("section.track-panel");
    await expect(panel).not.toHaveAttribute("data-unsupported", "");
    return Number(await panel.getAttribute("data-unsupported"));
  }

  async trackEnds(): Promise<ReadonlyArray<TrackEnd>> {
    return (await this.editState()).world.trackEnds;
  }

  async trackRoutes(): Promise<ReadonlyArray<TrackRoute>> {
    return (await this.editState()).routes;
  }

  async trainsOnRails(): Promise<number> {
    return Number(await this.page.locator("section.play-panel").getAttribute("data-trains"));
  }

  async laidTrack(): Promise<ReadonlyArray<LaidTrackPiece>> {
    return (await this.editState()).world.laidTrack;
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

  async plans(): Promise<ReadonlyArray<PlanRegion>> {
    return (await this.planState()).plans;
  }

  async planRows(): Promise<ReadonlyArray<PlanRow>> {
    const [check] = (await this.planState()).checks;
    return (check?.issues ?? []).map(({ rule, severity, message }) => ({
      rule,
      severity,
      message,
    }));
  }

  async drawTable(from: LatticePoint, to: LatticePoint): Promise<void> {
    await this.escape();
    await this.press("b");
    await this.dragFrom(from, to);
    await this.press("b");
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

export function routeMiddle(route: TrackRoute): LatticePoint {
  return {
    x: Math.round((route.from.xLdu + route.to.xLdu) / 2 / STUD) * STUD,
    z: Math.round((route.from.zLdu + route.to.zLdu) / 2 / STUD) * STUD,
  };
}

export function nearestLattice(end: TrackEnd): LatticePoint {
  return {
    x: Math.round(end.xLdu / STUD) * STUD,
    z: Math.round(end.zLdu / STUD) * STUD,
  };
}
