import { injectable } from "inversify";

export interface IVehicleIds {
  take(): number;
  release(id: number): void;
}

@injectable()
export class VehicleIds implements IVehicleIds {
  private next = 0;
  private readonly free: number[] = [];

  take(): number {
    return this.free.pop() ?? this.next++;
  }

  release(id: number): void {
    this.free.push(id);
  }
}
