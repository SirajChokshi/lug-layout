import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Camera,
} from "three/webgpu";
import type {
  GhostCue,
  GhostFootprint,
  GhostTone,
  SnapTarget,
  SnapTargetKind,
} from "../scene-backend.ts";
import type { PlasticMaterials } from "./plastic-materials.ts";

interface ToneLook {
  readonly tint: number;
  readonly glow: number;
  readonly glowIntensity: number;
  readonly pulse: number;
  readonly opacityScale: number;
  readonly pad: number;
  readonly bobs: boolean;
}

const TONES: Readonly<Record<GhostTone, ToneLook>> = {
  neutral: {
    tint: 0xffffff,
    glow: 0x000000,
    glowIntensity: 0,
    pulse: 0,
    opacityScale: 1,
    pad: 0x3b82f6,
    bobs: true,
  },
  valid: {
    tint: 0xd8ffd8,
    glow: 0x22c55e,
    glowIntensity: 0.22,
    pulse: 0,
    opacityScale: 1.1,
    pad: 0x22c55e,
    bobs: true,
  },
  snapped: {
    tint: 0xc8ffd0,
    glow: 0x4ade80,
    glowIntensity: 0.42,
    pulse: 0.18,
    opacityScale: 1.25,
    pad: 0x16a34a,
    bobs: false,
  },
  blocked: {
    tint: 0xffb4b4,
    glow: 0xef4444,
    glowIntensity: 0.5,
    pulse: 0,
    opacityScale: 0.9,
    pad: 0xdc2626,
    bobs: false,
  },
};

const TARGET_COLORS: Readonly<Record<SnapTargetKind, number>> = {
  candidate: 0x38bdf8,
  locked: 0xffd60a,
  blocked: 0xff3b3b,
};
const TARGET_OPACITY: Readonly<Record<SnapTargetKind, number>> = {
  candidate: 0.5,
  locked: 0.85,
  blocked: 0.8,
};
const TARGET_PULSE: Readonly<Record<SnapTargetKind, number>> = {
  candidate: 0.15,
  locked: 0.25,
  blocked: 0.2,
};
const TARGET_KINDS: ReadonlyArray<SnapTargetKind> = ["candidate", "locked", "blocked"];

const TARGET_RENDER_ORDER = 3;
const TAU = Math.PI * 2;
const QUARTER_TURN_RADIANS = Math.PI / 2;
const BOB_LDU = 4;
const BOB_PERIOD_MS = 1400;
const PULSE_PERIOD_MS = 420;
const TARGET_PULSE_PERIOD_MS = 900;
const PAD_LIFT_LDU = 0.5;
const PAD_OPACITY = 0.22;
const PAD_FLASH_OPACITY = 0.6;
const REENTER_MS = 260;
const REENTRY_LDU = 56;
const RING_MS = 460;
const RING_GROWTH = 0.45;
const RING_COLOR = 0xffffff;
const SHAKE_MS = 340;
const SHAKE_LDU = 7;
const SHAKE_HZ = 16;
const OVERSHOOT = 1.70158;

function easeOutBack(k: number): number {
  const t = k - 1;
  return 1 + (OVERSHOOT + 1) * t * t * t + OVERSHOOT * t * t;
}

function easeOutCubic(k: number): number {
  const t = 1 - k;
  return 1 - t * t * t;
}

function unitSquareOutline(): BufferGeometry {
  const h = 0.5;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      [-h, 0, -h, h, 0, -h, h, 0, -h, h, 0, h, h, 0, h, -h, 0, h, -h, 0, h, -h, 0, -h],
      3,
    ),
  );
  return geometry;
}

function flatPlane(): PlaneGeometry {
  const plane = new PlaneGeometry(1, 1);
  plane.rotateX(-QUARTER_TURN_RADIANS);
  return plane;
}

function overlayMaterial(color: number, opacity: number): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

export class GhostEffects {
  readonly root = new Group();
  private ghost: Group | undefined;
  private footprint: GhostFootprint | undefined;
  private shown = false;
  private reducedMotion = false;
  private tone: GhostTone = "neutral";
  private x = 0;
  private y = 0;
  private z = 0;
  private rot = 0;
  private originX = 0;
  private originZ = 0;
  private shakeStartMs = Number.NEGATIVE_INFINITY;
  private enterStartMs = Number.NEGATIVE_INFINITY;
  private dropped = false;
  private ringX = 0;
  private ringY = 0;
  private ringZ = 0;
  private ringStartMs = Number.NEGATIVE_INFINITY;
  private readonly outline = unitSquareOutline();
  private readonly padMaterial = overlayMaterial(TONES.neutral.pad, PAD_OPACITY);
  private readonly padOutlineMaterial = new LineBasicNodeMaterial({
    color: TONES.neutral.pad,
    transparent: true,
    depthWrite: false,
  });
  private readonly padFill = new Mesh(flatPlane(), this.padMaterial);
  private readonly padEdge = new LineSegments(this.outline, this.padOutlineMaterial);
  private readonly pad = new Group();
  private readonly ringMaterial = new LineBasicNodeMaterial({
    color: RING_COLOR,
    transparent: true,
    depthWrite: false,
  });
  private readonly ringGroup = new Group();
  private readonly ring = new LineSegments(this.outline, this.ringMaterial);
  private readonly targetBox = new BoxGeometry(1, 1, 1);
  private readonly targetMaterials: Readonly<Record<SnapTargetKind, MeshBasicNodeMaterial>> = {
    candidate: overlayMaterial(TARGET_COLORS.candidate, TARGET_OPACITY.candidate),
    locked: overlayMaterial(TARGET_COLORS.locked, TARGET_OPACITY.locked),
    blocked: overlayMaterial(TARGET_COLORS.blocked, TARGET_OPACITY.blocked),
  };
  private readonly targetGroup = new Group();
  private readonly targetMeshes: Mesh[] = [];
  private targets: ReadonlyArray<SnapTarget> = [];

  constructor(private materials: PlasticMaterials) {
    this.pad.add(this.padFill, this.padEdge);
    this.pad.visible = false;
    this.pad.renderOrder = 1;
    this.ringGroup.add(this.ring);
    this.ringGroup.visible = false;
    this.ringGroup.renderOrder = 2;
    this.root.add(this.pad, this.ringGroup, this.targetGroup);
  }

  useMaterials(materials: PlasticMaterials): void {
    this.materials = materials;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  attach(ghost: Group | undefined, footprint: GhostFootprint | undefined): void {
    this.ghost = ghost;
    this.footprint = footprint;
    this.shown = false;
    this.dropped = false;
    this.pad.visible = false;
    if (!footprint) return;
    const width = footprint.maxX - footprint.minX;
    const depth = footprint.maxZ - footprint.minZ;
    const centreX = (footprint.minX + footprint.maxX) / 2;
    const centreZ = (footprint.minZ + footprint.maxZ) / 2;
    const y = footprint.bottomY + PAD_LIFT_LDU;
    this.padFill.position.set(centreX, y, centreZ);
    this.padFill.scale.set(width, 1, depth);
    this.padEdge.position.set(centreX, y, centreZ);
    this.padEdge.scale.set(width, 1, depth);
  }

  place(x: number, y: number, z: number, rot: number, nowMs: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rot = rot;
    this.shown = true;
    if (!this.dropped) return;
    this.dropped = false;
    this.enterStartMs = nowMs;
  }

  setTone(tone: GhostTone): void {
    this.tone = tone;
  }

  play(cue: GhostCue, nowMs: number): void {
    switch (cue) {
      case "refuse":
        this.shakeStartMs = nowMs;
        return;
      case "drop":
        this.drop(nowMs);
        return;
      default: {
        const unhandled: never = cue;
        throw new Error(`unhandled cue ${String(unhandled)}`);
      }
    }
  }

  private drop(nowMs: number): void {
    if (!this.shown) return;
    this.shown = false;
    this.dropped = true;
    this.ringX = this.x;
    this.ringY = this.y;
    this.ringZ = this.z;
    this.ringStartMs = nowMs;
    this.ringGroup.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    const footprint = this.footprint;
    if (!footprint) return;
    this.ring.position.set(
      (footprint.minX + footprint.maxX) / 2,
      footprint.bottomY + PAD_LIFT_LDU,
      (footprint.minZ + footprint.maxZ) / 2,
    );
  }

  setTargets(targets: ReadonlyArray<SnapTarget>): void {
    this.targets = targets;
    for (let i = this.targetMeshes.length; i < targets.length; i++) {
      const mesh = new Mesh(this.targetBox, this.targetMaterials.locked);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = TARGET_RENDER_ORDER;
      this.targetMeshes.push(mesh);
      this.targetGroup.add(mesh);
    }
    for (let i = 0; i < this.targetMeshes.length; i++) {
      const mesh = this.targetMeshes[i];
      const target = targets[i];
      if (!mesh) continue;
      mesh.visible = target !== undefined;
      if (target) mesh.material = this.targetMaterials[target.kind];
    }
    this.positionTargets();
  }

  rebase(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.positionTargets();
  }

  private positionTargets(): void {
    for (let i = 0; i < this.targets.length; i++) {
      const mesh = this.targetMeshes[i];
      const target = this.targets[i];
      if (!mesh || !target) continue;
      const { box } = target;
      mesh.position.set(
        (box.minX + box.maxX) / 2 - this.originX,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2 - this.originZ,
      );
      mesh.scale.set(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
      mesh.updateMatrix();
    }
    this.targetGroup.updateMatrixWorld(true);
  }

  animate(nowMs: number, camera: Camera): void {
    const still = this.reducedMotion;
    this.animateTargets(still ? 0 : Math.sin((TAU * nowMs) / TARGET_PULSE_PERIOD_MS));
    this.animateRing(nowMs, still);
    const ghost = this.ghost;
    if (!ghost) return;
    const look = TONES[this.tone];
    const bob = look.bobs && !still;
    let offsetX = 0;
    let offsetY = bob ? BOB_LDU * (0.5 - 0.5 * Math.cos((TAU * nowMs) / BOB_PERIOD_MS)) : 0;
    let offsetZ = 0;
    let fade = 1;
    let padFlash = 0;
    const entering = nowMs - this.enterStartMs;
    if (entering < REENTER_MS) {
      const k = entering / REENTER_MS;
      if (!still) offsetY += REENTRY_LDU * (1 - easeOutBack(k));
      fade = k;
    }
    const shaking = nowMs - this.shakeStartMs;
    if (shaking < SHAKE_MS) {
      const k = shaking / SHAKE_MS;
      padFlash = 1 - k;
      if (!still) {
        const swing = SHAKE_LDU * Math.sin((TAU * SHAKE_HZ * shaking) / 1000) * (1 - k);
        const right = camera.matrixWorld.elements;
        const rightX = right[0] ?? 1;
        const rightZ = right[2] ?? 0;
        const length = Math.hypot(rightX, rightZ) || 1;
        offsetX = (swing * rightX) / length;
        offsetZ = (swing * rightZ) / length;
      }
    }
    const pulse = still ? 0 : look.pulse * Math.sin((TAU * nowMs) / PULSE_PERIOD_MS);
    this.applyLook(look, look.glowIntensity + pulse, look.opacityScale * fade);
    ghost.visible = this.shown;
    ghost.position.set(
      this.x - this.originX + offsetX,
      this.y + offsetY,
      this.z - this.originZ + offsetZ,
    );
    ghost.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
    this.pad.visible = this.shown && this.footprint !== undefined;
    this.padMaterial.color.setHex(look.pad);
    this.padOutlineMaterial.color.setHex(look.pad);
    this.padMaterial.opacity = PAD_OPACITY + (PAD_FLASH_OPACITY - PAD_OPACITY) * padFlash;
    this.pad.position.set(this.x - this.originX, this.y, this.z - this.originZ);
    this.pad.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    this.pad.updateMatrixWorld(true);
  }

  private applyLook(look: ToneLook, glowIntensity: number, opacityScale: number): void {
    const all = this.materials.all;
    const baseOpacities = this.materials.baseOpacities;
    for (let i = 0; i < all.length; i++) {
      const material = all[i];
      if (!material) continue;
      material.color.setHex(look.tint);
      material.emissive.setHex(look.glow);
      material.emissiveIntensity = glowIntensity;
      material.opacity = (baseOpacities[i] ?? 1) * opacityScale;
    }
  }

  private animateRing(nowMs: number, still: boolean): void {
    const elapsed = nowMs - this.ringStartMs;
    const footprint = this.footprint;
    if (elapsed >= RING_MS || footprint === undefined) {
      this.ringGroup.visible = false;
      return;
    }
    const k = elapsed / RING_MS;
    const growth = still ? 1 : 1 + RING_GROWTH * easeOutCubic(k);
    this.ring.scale.set(
      (footprint.maxX - footprint.minX) * growth,
      1,
      (footprint.maxZ - footprint.minZ) * growth,
    );
    this.ringMaterial.opacity = 1 - k;
    this.ringGroup.visible = true;
    this.ringGroup.position.set(this.ringX - this.originX, this.ringY, this.ringZ - this.originZ);
    this.ringGroup.updateMatrixWorld(true);
  }

  private animateTargets(wave: number): void {
    if (this.targets.length === 0) return;
    for (let i = 0; i < TARGET_KINDS.length; i++) {
      const kind = TARGET_KINDS[i];
      if (!kind) continue;
      this.targetMaterials[kind].opacity = TARGET_OPACITY[kind] + TARGET_PULSE[kind] * wave;
    }
  }
}
