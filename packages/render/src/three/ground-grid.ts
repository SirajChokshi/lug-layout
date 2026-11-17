import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Vector2,
  Vector4,
} from "three/webgpu";
import { float, positionWorld, smoothstep, step, uniform, vec2 } from "three/tsl";
import { gridAnchor, gridAnchorStep, levelLineOffsets, levelReachSteps } from "../grid-lines.ts";
import type { GridArea, GridLevel, GroundGrid } from "../scene-backend.ts";

const FADE_START_FRACTION = 0.55;
const FULL_OPACITY_PITCH_FACTOR = 2;
const GRID_RENDER_ORDER = -1;
const CLIP_SLACK_LDU = 0.5;

function opacityUniform(value: number) {
  return uniform(value);
}

function centreUniform() {
  return uniform(new Vector2());
}

function clipUniform() {
  return uniform(new Vector4());
}

type ClipUniform = ReturnType<typeof clipUniform>;

interface LevelRecord {
  readonly level: GridLevel;
  readonly lines: LineSegments;
  readonly opacity: ReturnType<typeof opacityUniform>;
}

interface AreaClip {
  readonly area: GridArea;
  readonly clip: ClipUniform;
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

function insideClip(clip: ClipUniform) {
  return step(clip.x, positionWorld.x)
    .mul(step(positionWorld.x, clip.z))
    .mul(step(clip.y, positionWorld.z))
    .mul(step(positionWorld.z, clip.w));
}

function insideAny(clips: ReadonlyArray<AreaClip>) {
  const [first, ...rest] = clips;
  if (!first) return float(1);
  let inside = insideClip(first.clip);
  for (const { clip } of rest) inside = inside.max(insideClip(clip));
  return inside;
}

function levelRecord(
  level: GridLevel,
  index: number,
  levels: ReadonlyArray<GridLevel>,
  centre: ReturnType<typeof centreUniform>,
  clips: ReadonlyArray<AreaClip>,
): LevelRecord {
  const fadeEnd = level.stepLdu * level.halfSteps;
  const opacity = opacityUniform(level.opacity);
  const radius = vec2(positionWorld.x, positionWorld.z).sub(centre).length();
  const material = new LineBasicNodeMaterial({
    color: level.color,
    transparent: true,
  });
  material.depthWrite = false;
  material.opacityNode = opacity
    .mul(float(1).sub(smoothstep(float(fadeEnd * FADE_START_FRACTION), float(fadeEnd), radius)))
    .mul(insideAny(clips));
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
  private clips: AreaClip[] = [];
  private anchorStep = 1;
  private y = 0;

  set(grid: GroundGrid | null): void {
    for (const record of this.levels) {
      this.group.remove(record.lines);
      record.lines.geometry.dispose();
      const material: unknown = record.lines.material;
      if (material instanceof LineBasicNodeMaterial) material.dispose();
    }
    this.clips = (grid?.areas ?? []).map((area) => ({ area, clip: clipUniform() }));
    const clips = this.clips;
    this.levels = grid
      ? grid.levels.map((level, index) =>
          levelRecord(level, index, grid.levels, this.centre, clips),
        )
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
    for (const { area, clip } of this.clips) {
      clip.value.set(
        area.minX - renderOriginX - CLIP_SLACK_LDU,
        area.minZ - renderOriginZ - CLIP_SLACK_LDU,
        area.maxX - renderOriginX + CLIP_SLACK_LDU,
        area.maxZ - renderOriginZ + CLIP_SLACK_LDU,
      );
    }
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
