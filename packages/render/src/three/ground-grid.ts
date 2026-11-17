import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Vector2,
} from "three/webgpu";
import { float, positionWorld, smoothstep, uniform, vec2 } from "three/tsl";
import { gridAnchor, gridAnchorStep, levelLineOffsets, levelReachSteps } from "../grid-lines.ts";
import type { GridLevel, GroundGrid } from "../scene-backend.ts";

const FADE_START_FRACTION = 0.55;
const FULL_OPACITY_PITCH_FACTOR = 2;
const GRID_RENDER_ORDER = -1;

function opacityUniform(value: number) {
  return uniform(value);
}

function centreUniform() {
  return uniform(new Vector2());
}

interface LevelRecord {
  readonly level: GridLevel;
  readonly lines: LineSegments;
  readonly opacity: ReturnType<typeof opacityUniform>;
}

function levelGeometry(level: GridLevel, levels: ReadonlyArray<GridLevel>): BufferGeometry {
  const extent = level.stepLdu * levelReachSteps(level, gridAnchorStep(levels));
  const positions: number[] = [];
  for (const at of levelLineOffsets(level, levels)) {
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
  centre: ReturnType<typeof centreUniform>,
): LevelRecord {
  const fadeEnd = level.stepLdu * level.halfSteps;
  const opacity = opacityUniform(level.opacity);
  const radius = vec2(positionWorld.x, positionWorld.z).sub(centre).length();
  const material = new LineBasicNodeMaterial({
    color: level.color,
    transparent: true,
  });
  material.depthWrite = false;
  material.opacityNode = opacity.mul(
    float(1).sub(smoothstep(float(fadeEnd * FADE_START_FRACTION), float(fadeEnd), radius)),
  );
  const lines = new LineSegments(levelGeometry(level, levels), material);
  lines.matrixAutoUpdate = false;
  lines.frustumCulled = false;
  lines.renderOrder = GRID_RENDER_ORDER + index;
  return { level, lines, opacity };
}

export class GroundGridLayer {
  readonly group = new Group();
  private readonly centre = centreUniform();
  private levels: LevelRecord[] = [];
  private anchorStep = 1;
  private y = 0;

  set(grid: GroundGrid | null): void {
    for (const record of this.levels) {
      this.group.remove(record.lines);
      record.lines.geometry.dispose();
      const material: unknown = record.lines.material;
      if (material instanceof LineBasicNodeMaterial) material.dispose();
    }
    this.levels = grid
      ? grid.levels.map((level, index) => levelRecord(level, index, grid.levels, this.centre))
      : [];
    this.anchorStep = grid ? gridAnchorStep(grid.levels) : 1;
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
    this.centre.value.set(targetX - renderOriginX, targetZ - renderOriginZ);
    const anchorX = gridAnchor(targetX, this.anchorStep) - renderOriginX;
    const anchorZ = gridAnchor(targetZ, this.anchorStep) - renderOriginZ;
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
      lines.position.set(anchorX, this.y, anchorZ);
      lines.updateMatrix();
      lines.updateMatrixWorld(true);
    }
  }
}
