import type { Task } from "../../shared/api";
import type { Checkout } from "../../shared/types";
import type { ToolActivity } from "./hooks/useToolActivity";

export function activeWorktrees(targets: Checkout[], tasks: Task[]) {
  const active = new Set(
    tasks
      .filter((task) =>
        ["working", "needs-you", "publishing"].includes(task.status),
      )
      .map((task) => task.id),
  );
  return targets.filter(
    (target) => !target.source && target.taskId && active.has(target.taskId),
  );
}

export function lineLayout(count: number) {
  const half = Math.max(1.7, count * 1.7);
  return {
    half,
    radius: 1.65,
    length: half * 4 + Math.PI * 3.3,
    stations: Array.from(
      { length: count },
      (_, i) => (i - (count - 1) / 2) * 3.4,
    ),
  };
}

// Capsule-shaped sushi belt. The same centerline places slats and moving plates.
export function beltPoint(
  distance: number,
  layout: ReturnType<typeof lineLayout>,
  point = { x: 0, z: 0, angle: 0 },
) {
  const { half, radius, length } = layout;
  let d = ((distance % length) + length) % length;
  if (d < half * 2) {
    point.x = -half + d;
    point.z = radius;
    point.angle = Math.PI / 2;
    return point;
  }
  d -= half * 2;
  if (d < Math.PI * radius) {
    const a = d / radius;
    point.x = half + Math.sin(a) * radius;
    point.z = Math.cos(a) * radius;
    point.angle = Math.PI / 2 + a;
    return point;
  }
  d -= Math.PI * radius;
  if (d < half * 2) {
    point.x = half - d;
    point.z = -radius;
    point.angle = -Math.PI / 2;
    return point;
  }
  d -= half * 2;
  const a = d / radius;
  point.x = -half - Math.sin(a) * radius;
  point.z = -Math.cos(a) * radius;
  point.angle = -Math.PI / 2 + a;
  return point;
}

export interface Shipment {
  id: string;
  taskId: string;
  name: string;
  status: ToolActivity["status"];
  startedAt: number;
  releasedAt: number | null;
}

export function syncShipments(
  shipments: Map<string, Shipment>,
  calls: ToolActivity[],
  taskIds: Set<string>,
  clock: number,
  now: number,
) {
  const ids = new Set(calls.map((call) => call.id));
  for (const [id, shipment] of shipments)
    if (!ids.has(id) || !taskIds.has(shipment.taskId)) shipments.delete(id);
  for (const call of calls) {
    if (!taskIds.has(call.taskId)) continue;
    let shipment = shipments.get(call.id);
    if (
      !shipment &&
      (call.status === "running" ||
        (call.observedAt !== null && now - call.observedAt < 3000))
    ) {
      shipment = {
        id: call.id,
        taskId: call.taskId,
        name: call.name,
        status: call.status,
        startedAt: clock,
        releasedAt: null,
      };
      shipments.set(call.id, shipment);
    }
    if (!shipment) continue;
    shipment.status = call.status;
    if (call.status !== "running" && shipment.releasedAt === null)
      shipment.releasedAt = Math.max(clock, shipment.startedAt + 650);
  }
}

export function shipmentProgress(shipment: Shipment, clock: number) {
  if (shipment.releasedAt === null || clock < shipment.releasedAt)
    return Math.min(
      0.12,
      (Math.max(0, clock - shipment.startedAt) / 650) * 0.12,
    );
  return Math.min(
    1,
    0.12 + (Math.max(0, clock - shipment.releasedAt) / 6500) * 0.88,
  );
}

export const stationColors = [
  "#168bff",
  "#ff584e",
  "#00b998",
  "#9659f4",
  "#ffb300",
  "#ec47a1",
];
export function seedHash(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}
export function seededRandom(seed: string) {
  let state = seedHash(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function stationColor(id: string) {
  return stationColors[seedHash(id) % stationColors.length];
}
export function toolColor(name: string, status = "") {
  return status === "error" || status === "interrupted"
    ? "#ef4444"
    : /edit|write|patch/.test(name)
      ? "#00bf88"
      : /read|search|grep|glob|list/.test(name)
        ? "#168bff"
        : /bash|shell|exec|test/.test(name)
          ? "#ffb300"
          : "#9957ff";
}
