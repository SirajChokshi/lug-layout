import {
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Vector2,
  Vector3,
  type Node,
} from "three/webgpu";
import {
  abs,
  clamp,
  float,
  fract,
  fwidth,
  max,
  mix,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import type { GroundGrid } from "../scene-backend.ts";

interface LineStyle {
  readonly color: number;
  readonly opacity: number;
  readonly widthPx: number;
  readonly minPitchPx: number;
}

const GROUND_COLOR = 0xd5d0c7;
const LINE_STYLES_FINEST_FIRST: ReadonlyArray<LineStyle> = [
  { color: 0x8f8a81, opacity: 0.55, widthPx: 1, minPitchPx: 6 },
  { color: 0x66615a, opacity: 0.7, widthPx: 1.25, minPitchPx: 6 },
  { color: 0x3f3b35, opacity: 0.8, widthPx: 1.75, minPitchPx: 6 },
];
const FULL_OPACITY_PITCH_FACTOR = 3;
const ANTIALIAS_HALF_PX = 0.5;
const SMALLEST_CELLS_PER_PX = 1e-6;
const HORIZON_FADE_START = 0.45;
const GROUND_RENDER_ORDER = -10;
const GRID_LIFT_LDU = 0.5;

function vec2Uniform() {
  return uniform(new Vector2());
}

type Vec2Uniform = ReturnType<typeof vec2Uniform>;

interface Level {
  readonly stepLdu: number;
  readonly style: LineStyle;
  readonly originOffset: Vec2Uniform;
}

function positiveRemainder(value: number, step: number): number {
  return ((value % step) + step) % step;
}

function rgbOf(hex: number): Node<"vec3"> {
  const color = new Color(hex);
  return vec3(color.r, color.g, color.b);
}

function lineCoverage(distancePx: Node<"float">, style: LineStyle): Node<"float"> {
  return clamp(float(style.widthPx / 2 + ANTIALIAS_HALF_PX).sub(distancePx), 0, 1);
}

function pitchFade(cellsPerPx: Node<"float">, style: LineStyle): Node<"float"> {
  const pitchPx = float(1).div(cellsPerPx);
  return clamp(
    pitchPx.sub(style.minPitchPx).div(style.minPitchPx * FULL_OPACITY_PITCH_FACTOR),
    0,
    1,
  );
}

function axisAlpha(toLine: Node<"float">, cellsPerPx: Node<"float">, style: LineStyle) {
  return lineCoverage(toLine.div(cellsPerPx), style).mul(pitchFade(cellsPerPx, style));
}

function levelAlpha(level: Level): Node<"float"> {
  const cell = positionWorld.xz.add(level.originOffset).div(level.stepLdu);
  const toLine = abs(fract(cell.sub(0.5)).sub(0.5));
  const cellsPerPx = max(fwidth(cell), float(SMALLEST_CELLS_PER_PX));
  const alongX = axisAlpha(toLine.x, cellsPerPx.x, level.style);
  const alongZ = axisAlpha(toLine.y, cellsPerPx.y, level.style);
  return max(alongX, alongZ).mul(level.style.opacity);
}

export class GroundGridLayer {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>;
  private readonly hazeCircle = uniform(new Vector3());
  private levels: ReadonlyArray<Level> = [];
  private stepsKey = "";
  private y = 0;
  private gridSet = false;

  constructor(private readonly skyColor: number) {
    const geometry = new PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geometry, new MeshBasicNodeMaterial());
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = GROUND_RENDER_ORDER;
    this.mesh.visible = false;
  }

  set(grid: GroundGrid | null): void {
    this.gridSet = grid !== null;
    if (grid) {
      this.y = grid.y;
      const stepsKey = grid.stepsLdu.join(",");
      if (stepsKey !== this.stepsKey) this.build(grid.stepsLdu);
      this.stepsKey = stepsKey;
    }
    this.mesh.visible = this.gridSet;
  }

  private build(stepsLdu: ReadonlyArray<number>): void {
    const sorted = stepsLdu.toSorted((a, b) => a - b);
    const styles = LINE_STYLES_FINEST_FIRST.slice(-sorted.length);
    if (styles.length < sorted.length) {
      throw new Error(`the ground grid draws at most ${LINE_STYLES_FINEST_FIRST.length} steps`);
    }
    this.levels = sorted.map((stepLdu, index) => {
      const style = styles[index];
      if (!(stepLdu > 0) || !style) throw new Error(`grid step ${stepLdu} LDU is not positive`);
      return { stepLdu, style, originOffset: vec2Uniform() };
    });
    let rgb: Node<"vec3"> = rgbOf(GROUND_COLOR);
    for (const level of this.levels) rgb = mix(rgb, rgbOf(level.style.color), levelAlpha(level));
    const radius = this.hazeCircle.z;
    const distance = positionWorld.xz.sub(this.hazeCircle.xy).length();
    const haze = smoothstep(radius.mul(HORIZON_FADE_START), radius, distance);
    const material = this.mesh.material;
    material.colorNode = mix(rgb, rgbOf(this.skyColor), haze);
    material.needsUpdate = true;
  }

  follow(
    targetX: number,
    targetZ: number,
    renderOriginX: number,
    renderOriginZ: number,
    radius: number,
  ): void {
    if (!this.gridSet) return;
    const localX = targetX - renderOriginX;
    const localZ = targetZ - renderOriginZ;
    this.hazeCircle.value.set(localX, localZ, radius);
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      if (!level) continue;
      level.originOffset.value.set(
        positiveRemainder(renderOriginX, level.stepLdu),
        positiveRemainder(renderOriginZ, level.stepLdu),
      );
    }
    const mesh = this.mesh;
    mesh.position.set(localX, this.y + GRID_LIFT_LDU, localZ);
    mesh.scale.set(radius, 1, radius);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  }
}
