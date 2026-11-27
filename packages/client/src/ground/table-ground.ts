import { SCENE_BACKEND, type GroundUnderlay, type ISceneBackend } from "@brr/render";
import type { TablePlane } from "@brr/schema/bundle";
import { inject, injectable } from "inversify";

export interface GroundView {
  readonly showGrid: boolean;
}

export interface ITableGround {
  view(): GroundView;
  subscribe(listener: () => void): () => void;
  lay(tablePlane: TablePlane): void;
  setShowGrid(show: boolean): void;
  setUnderlay(underlay: GroundUnderlay | null): void;
}

@injectable()
export class TableGround implements ITableGround {
  private readonly listeners = new Set<() => void>();
  private state: GroundView = { showGrid: true };
  private topYLdu: number | null = null;
  private underlay: GroundUnderlay | null = null;

  constructor(@inject(SCENE_BACKEND) private readonly backend: Pick<ISceneBackend, "setGround">) {}

  view(): GroundView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  lay(tablePlane: TablePlane): void {
    this.topYLdu = -tablePlane.depthBelowTopLdu;
    this.draw();
  }

  setShowGrid(show: boolean): void {
    if (show === this.state.showGrid) return;
    this.state = { showGrid: show };
    this.draw();
    for (const listener of this.listeners) listener();
  }

  setUnderlay(underlay: GroundUnderlay | null): void {
    this.underlay = underlay;
    this.draw();
  }

  private draw(): void {
    if (this.topYLdu === null) return;
    this.backend.setGround({
      topYLdu: this.topYLdu,
      grid: this.state.showGrid,
      underlay: this.underlay,
    });
  }
}
