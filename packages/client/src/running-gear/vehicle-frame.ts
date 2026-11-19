import type { PartVehicle } from "@brr/catalog";
import type { Vec3 } from "@brr/schema/bundle";

export function toVehicleFrame(vehicle: PartVehicle, model: Vec3): Vec3 {
  const cos = Math.cos(vehicle.yaw);
  const sin = Math.sin(vehicle.yaw);
  const dx = model[0] - vehicle.origin[0];
  const dz = model[2] - vehicle.origin[1];
  return [dx * cos + dz * sin, model[1], -dx * sin + dz * cos];
}
