import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
} from "three/webgpu";
import { float, positionLocal, smoothstep, uniform, vec2 } from "three/tsl";
import type { GridLevel, GroundGrid } from "../scene-backend.ts";

const FADE_START_FRACTION = 0.55;
const FULL_OPACITY_PITCH_FACTOR = 2;
const GRID_RENDER_ORDER = -1;

function opacityUniform(value: number) {
  return uniform(value);
}

interface LevelRecord {
  readonly level: GridLevel;
  readonly lines: LineSegments;
  readonly opacity: ReturnType<typeof opacityUniform>;
}

function drawnByCoarser(at: number, coarserSteps: ReadonlyArray<number>): boolean {
  return coarserSteps.some((step) => at % step === 0);
}

function levelGeometry(level: GridLevel, coarserSteps: ReadonlyArray<number>): BufferGeometry {
  const extent = level.stepLdu * level.halfSteps;
  const positions: number[] = [];
  for (let i = -level.halfSteps; i <= level.halfSteps; i++) {
    const at = i * level.stepLdu;
    if (drawnByCoarser(at, coarserSteps)) continue;
    positions.push(at, 0, -extent, at, 0, extent, -extent, 0, at, extent, 0, at);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

function levelRecord(
  level: GridLevel,
  index: number,
  levels: ReadonlyArray<GridLevel>,
): LevelRecord {
  const coarserSteps = levels
    .filter((other) => other.stepLdu > level.stepLdu)
    .map((other) => other.stepLdu);
  const extent = level.stepLdu * level.halfSteps;
  const opacity = opacityUniform(level.opacity);
  const radius = vec2(positionLocal.x, positionLocal.z).length();
  const material = new LineBasicNodeMaterial({
    color: level.color,
    transparent: true,
  });
  material.depthWrite = false;
  material.opacityNode = opacity.mul(
    float(1).sub(smoothstep(float(extent * FADE_START_FRACTION), float(extent), radius)),
  );
  const lines = new LineSegments(levelGeometry(level, coarserSteps), material);
  lines.matrixAutoUpdate = false;
  lines.frustumCulled = false;
  lines.renderOrder = GRID_RENDER_ORDER + index;
  return { level, lines, opacity };
}

function snapped(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export class GroundGridLayer {
  readonly group = new Group();
  private levels: LevelRecord[] = [];
  private y = 0;

  set(grid: GroundGrid | null): void {
    for (const record of this.levels) {
      this.group.remove(record.lines);
      record.lines.geometry.dispose();
      const material: unknown = record.lines.material;
      if (material instanceof LineBasicNodeMaterial) material.dispose();
    }
    this.levels = grid ? grid.levels.map(levelRecord) : [];
    this.y = grid?.y ?? 0;
    for (const record of this.levels) this.group.add(record.lines);
  }

  follow(
    targetX: number,
    targetZ: number,
    renderOriginX: number,
    renderOriginZ: number,
    focalLengthPx: number,
    distance: number,
  ): void {
    for (let i = 0; i < this.levels.length; i++) {
      const record = this.levels[i];
      if (!record) continue;
      const { level, lines } = record;
      const pitchPx = (level.stepLdu * focalLengthPx) / Math.max(distance, 1);
      const fadeIn = Math.min(
        1,
        Math.max(0, (pitchPx - level.minPitchPx) / (level.minPitchPx * FULL_OPACITY_PITCH_FACTOR)),
      );
      lines.visible = fadeIn > 0;
      record.opacity.value = level.opacity * fadeIn;
      lines.position.set(
        snapped(targetX, level.stepLdu) - renderOriginX,
        this.y,
        snapped(targetZ, level.stepLdu) - renderOriginZ,
      );
      lines.updateMatrix();
      lines.updateMatrixWorld(true);
    }
  }
}
