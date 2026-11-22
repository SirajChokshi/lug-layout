import { CHUNK_STUDS, STUD_LDU } from "@brr/math";
import {
  Color,
  FrontSide,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Node,
  type Object3D,
} from "three/webgpu";
import {
  abs,
  cameraPosition,
  float,
  fract,
  fwidth,
  max,
  mix,
  normalWorld,
  positionWorld,
  saturate,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { GUIDE_GRID_STUDS, type GroundSettings } from "../scene-backend.ts";

const GROUND_COLOR = 0xbfbab0;
const UPWARD_NORMAL_Y = 0.5;
const GROUND_RENDER_ORDER = -1;
const LINE_SOFTNESS_PX = 0.5;
const VANISHED_SPACING_PX = 4;
const FULL_SPACING_PX = 18;
const LEAST_LDU_PER_PX = 1e-6;
const FOG_START_EYE_DISTANCES = 2.5;
const FOG_END_EYE_DISTANCES = 9;
const FOG_SHARE_OF_FAR_PLANE = 0.8;
const FOG_START_SHARE_OF_END = FOG_START_EYE_DISTANCES / FOG_END_EYE_DISTANCES;
const NO_FOG_FAR_PLANES = 4;
const ORTHOGRAPHIC_REACH_MARGIN = 1.25;

interface GridLevel {
  readonly stepLdu: number;
  readonly color: number;
  readonly opacity: number;
  readonly halfWidthPx: number;
}

const GRID_LEVELS: ReadonlyArray<GridLevel> = [
  { stepLdu: STUD_LDU, color: 0x857d71, opacity: 0.38, halfWidthPx: 0.5 },
  { stepLdu: GUIDE_GRID_STUDS * STUD_LDU, color: 0x655d51, opacity: 0.6, halfWidthPx: 0.6 },
  { stepLdu: CHUNK_STUDS * STUD_LDU, color: 0x463f35, opacity: 0.72, halfWidthPx: 0.85 },
];

function linearRgb(srgb: number): Node<"vec3"> {
  const color = new Color(srgb);
  return vec3(color.r, color.g, color.b);
}

function lineCoverage(level: GridLevel, pxPerLdu: Node<"vec2">): Node<"float"> {
  const cell = positionWorld.xz.div(level.stepLdu);
  const spacingPx = pxPerLdu.mul(level.stepLdu);
  const offLinePx = abs(fract(cell.add(0.5)).sub(0.5)).mul(spacingPx);
  const onLine = saturate(vec2(level.halfWidthPx + LINE_SOFTNESS_PX).sub(offLinePx));
  const shown = smoothstep(VANISHED_SPACING_PX, FULL_SPACING_PX, spacingPx);
  const visible = onLine.mul(shown);
  return max(visible.x, visible.y);
}

export class GroundPlane {
  private readonly mesh: Mesh;
  private readonly gridShown = uniform(1);
  private readonly fogStart = uniform(0);
  private readonly fogEnd = uniform(1);
  private topYLdu = 0;

  constructor(
    parent: Object3D,
    horizonColor: number,
    private readonly farPlaneLdu: number,
  ) {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
      fog: false,
    });
    material.colorNode = mix(
      this.gridded(GROUND_COLOR),
      linearRgb(horizonColor),
      smoothstep(this.fogStart, this.fogEnd, positionWorld.distance(cameraPosition)),
    );
    this.mesh = new Mesh(geometry, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = GROUND_RENDER_ORDER;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  private gridded(baseSrgb: number): Node<"vec3"> {
    const lduPerPx = max(fwidth(positionWorld.xz), vec2(LEAST_LDU_PER_PX, LEAST_LDU_PER_PX));
    const pxPerLdu = float(1).div(lduPerPx);
    let color = linearRgb(baseSrgb);
    for (const level of GRID_LEVELS) {
      const alpha = lineCoverage(level, pxPerLdu).mul(level.opacity).mul(this.gridShown);
      color = mix(color, linearRgb(level.color), alpha);
    }
    return color;
  }

  griddedTop(baseSrgb: number): Node<"vec3"> {
    return mix(linearRgb(baseSrgb), this.gridded(baseSrgb), step(UPWARD_NORMAL_Y, normalWorld.y));
  }

  configure(settings: GroundSettings | null): void {
    this.mesh.visible = settings !== null;
    if (!settings) return;
    this.topYLdu = settings.topYLdu;
    this.gridShown.value = settings.grid ? 1 : 0;
  }

  followPerspective(centreX: number, centreZ: number, eyeDistanceLdu: number): void {
    const fogEnd = Math.min(
      eyeDistanceLdu * FOG_END_EYE_DISTANCES,
      this.farPlaneLdu * FOG_SHARE_OF_FAR_PLANE,
    );
    this.fogStart.value = fogEnd * FOG_START_SHARE_OF_END;
    this.fogEnd.value = fogEnd;
    this.place(centreX, centreZ, fogEnd + eyeDistanceLdu);
  }

  followOrthographic(
    centreX: number,
    centreZ: number,
    halfWidthLdu: number,
    halfHeightLdu: number,
  ): void {
    this.fogStart.value = this.farPlaneLdu * NO_FOG_FAR_PLANES;
    this.fogEnd.value = this.farPlaneLdu * (NO_FOG_FAR_PLANES + 1);
    this.place(
      centreX,
      centreZ,
      Math.hypot(halfWidthLdu, halfHeightLdu) * ORTHOGRAPHIC_REACH_MARGIN,
    );
  }

  private place(centreX: number, centreZ: number, reachLdu: number): void {
    this.mesh.position.set(centreX, this.topYLdu, centreZ);
    this.mesh.scale.set(2 * reachLdu, 1, 2 * reachLdu);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }
}
