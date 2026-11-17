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
  type MeshStandardNodeMaterial,
  type PerspectiveCamera,
} from "three/webgpu";
import type {
  GhostCue,
  GhostFootprint,
  GhostTone,
  SnapTarget,
  SnapTargetKind,
} from "../scene-backend.ts";

interface ToneLook {
  readonly tint: number;
  readonly glow: number;
  readonly glowIntensity: number;
  readonly pulse: number;
  readonly opacity: number;
  readonly pad: number;
  readonly bobs: boolean;
}

const TONES: Readonly<Record<GhostTone, ToneLook>> = {
  neutral: {
    tint: 0xffffff,
    glow: 0x000000,
    glowIntensity: 0,
    pulse: 0,
    opacity: 0.55,
    pad: 0x3b82f6,
    bobs: true,
  },
  valid: {
    tint: 0xd8ffd8,
    glow: 0x22c55e,
    glowIntensity: 0.22,
    pulse: 0,
    opacity: 0.6,
    pad: 0x22c55e,
    bobs: true,
  },
  snapped: {
    tint: 0xc8ffd0,
    glow: 0x4ade80,
    glowIntensity: 0.42,
    pulse: 0.18,
    opacity: 0.7,
    pad: 0x16a34a,
    bobs: false,
  },
  blocked: {
    tint: 0xffb4b4,
    glow: 0xef4444,
    glowIntensity: 0.5,
    pulse: 0,
    opacity: 0.5,
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
const DROP_HIDE_MS = 110;
const DROP_REENTER_MS = 260;
const DROP_REENTRY_LDU = 56;
const RING_MS = 460;
const RING_GROWTH = 0.45;
const RING_COLOR = 0xffffff;
const SHAKE_MS = 340;
const SHAKE_LDU = 7;
const SHAKE_HZ = 16;
const OVERSHOOT = 1.70158;

function easeOutBack(k: number): number {
  const c = OVERSHOOT;
  const t = k - 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
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
  private tone: GhostTone = "neutral";
  private x = 0;
  private y = 0;
  private z = 0;
  private rot = 0;
  private originX = 0;
  private originZ = 0;
  private cue: GhostCue | null = null;
  private cueStartMs = 0;
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
  private targets: ReadonlyArray<SnapTarget> = [];

  constructor(private readonly materials: ReadonlyArray<MeshStandardNodeMaterial>) {
    this.pad.add(
      new Mesh(flatPlane(), this.padMaterial),
      new LineSegments(this.outline, this.padOutlineMaterial),
    );
    this.pad.visible = false;
    this.pad.renderOrder = 1;
    this.ringGroup.add(this.ring);
    this.ringGroup.visible = false;
    this.ringGroup.renderOrder = 2;
    this.root.add(this.pad, this.ringGroup, this.targetGroup);
    this.applyTone();
  }

  attach(ghost: Group | undefined, footprint: GhostFootprint | undefined): void {
    this.ghost = ghost;
    this.footprint = footprint;
    this.shown = false;
    this.cue = null;
    this.pad.visible = false;
    const [fill, edge] = this.pad.children;
    if (!footprint) return;
    const width = footprint.maxX - footprint.minX;
    const depth = footprint.maxZ - footprint.minZ;
    const centreX = (footprint.minX + footprint.maxX) / 2;
    const centreZ = (footprint.minZ + footprint.maxZ) / 2;
    const y = footprint.bottomY + PAD_LIFT_LDU;
    for (const child of [fill, edge]) {
      if (!child) continue;
      child.position.set(centreX, y, centreZ);
      child.scale.set(width, 1, depth);
    }
  }

  place(x: number, y: number, z: number, rot: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rot = rot;
    this.shown = true;
  }

  setTone(tone: GhostTone): void {
    if (tone === this.tone) return;
    this.tone = tone;
    this.applyTone();
  }

  private applyTone(): void {
    const look = TONES[this.tone];
    for (const material of this.materials) {
      material.color.setHex(look.tint);
      material.emissive.setHex(look.glow);
      material.emissiveIntensity = look.glowIntensity;
      material.opacity = look.opacity;
    }
    this.padMaterial.color.setHex(look.pad);
    this.padOutlineMaterial.color.setHex(look.pad);
  }

  play(cue: GhostCue, nowMs: number): void {
    this.cue = cue;
    this.cueStartMs = nowMs;
    if (cue !== "drop" || !this.shown) return;
    this.ringX = this.x;
    this.ringY = this.y;
    this.ringZ = this.z;
    this.ringStartMs = nowMs;
    this.ringGroup.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    const footprint = this.footprint;
    if (footprint) {
      this.ring.position.set(
        (footprint.minX + footprint.maxX) / 2,
        footprint.bottomY + PAD_LIFT_LDU,
        (footprint.minZ + footprint.maxZ) / 2,
      );
    }
  }

  setTargets(targets: ReadonlyArray<SnapTarget>): void {
    if (targets.length === 0 && this.targets.length === 0) return;
    this.targetGroup.clear();
    this.targets = targets;
    for (const target of targets) {
      const mesh = new Mesh(this.targetBox, this.targetMaterials[target.kind]);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = TARGET_RENDER_ORDER;
      this.targetGroup.add(mesh);
    }
    this.positionTargets();
  }

  rebase(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.positionTargets();
  }

  private positionTargets(): void {
    const meshes = this.targetGroup.children;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
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

  animate(nowMs: number, camera: PerspectiveCamera): void {
    this.animateTargets(nowMs);
    this.animateRing(nowMs);
    const ghost = this.ghost;
    if (!ghost) return;
    const look = TONES[this.tone];
    let offsetX = 0;
    let offsetY = look.bobs ? BOB_LDU * (0.5 - 0.5 * Math.cos((TAU * nowMs) / BOB_PERIOD_MS)) : 0;
    let offsetZ = 0;
    let fade = 1;
    let hidden = false;
    let padFlash = 0;
    const elapsed = nowMs - this.cueStartMs;
    if (this.cue === "drop") {
      if (elapsed < DROP_HIDE_MS) {
        hidden = true;
      } else if (elapsed < DROP_HIDE_MS + DROP_REENTER_MS) {
        const k = (elapsed - DROP_HIDE_MS) / DROP_REENTER_MS;
        offsetY += DROP_REENTRY_LDU * (1 - easeOutBack(k));
        fade = k;
      } else {
        this.cue = null;
      }
    } else if (this.cue === "refuse") {
      if (elapsed < SHAKE_MS) {
        const k = elapsed / SHAKE_MS;
        const swing = SHAKE_LDU * Math.sin((TAU * SHAKE_HZ * elapsed) / 1000) * (1 - k);
        const right = camera.matrixWorld.elements;
        const rightX = right[0] ?? 1;
        const rightZ = right[2] ?? 0;
        const length = Math.hypot(rightX, rightZ) || 1;
        offsetX = (swing * rightX) / length;
        offsetZ = (swing * rightZ) / length;
        padFlash = 1 - k;
      } else {
        this.cue = null;
      }
    }
    const pulse = look.pulse * Math.sin((TAU * nowMs) / PULSE_PERIOD_MS);
    for (const material of this.materials) {
      material.emissiveIntensity = look.glowIntensity + pulse;
      material.opacity = look.opacity * fade;
    }
    ghost.visible = this.shown && !hidden;
    ghost.position.set(
      this.x - this.originX + offsetX,
      this.y + offsetY,
      this.z - this.originZ + offsetZ,
    );
    ghost.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
    this.pad.visible = this.shown && this.footprint !== undefined;
    this.padMaterial.opacity = PAD_OPACITY + (PAD_FLASH_OPACITY - PAD_OPACITY) * padFlash;
    this.pad.position.set(this.x - this.originX, this.y, this.z - this.originZ);
    this.pad.rotation.set(0, this.rot * QUARTER_TURN_RADIANS, 0);
    this.pad.updateMatrixWorld(true);
  }

  private animateRing(nowMs: number): void {
    const elapsed = nowMs - this.ringStartMs;
    if (elapsed >= RING_MS || this.footprint === undefined) {
      this.ringGroup.visible = false;
      return;
    }
    const k = elapsed / RING_MS;
    const growth = 1 + RING_GROWTH * easeOutCubic(k);
    const footprint = this.footprint;
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

  private animateTargets(nowMs: number): void {
    if (this.targets.length === 0) return;
    const wave = Math.sin((TAU * nowMs) / TARGET_PULSE_PERIOD_MS);
    for (let i = 0; i < TARGET_KINDS.length; i++) {
      const kind = TARGET_KINDS[i];
      if (!kind) continue;
      this.targetMaterials[kind].opacity = TARGET_OPACITY[kind] + TARGET_PULSE[kind] * wave;
    }
  }
}
