import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { Task } from "../../shared/api";
import type { Checkout } from "../../shared/types";
import type { ToolActivity } from "./hooks/useToolActivity";
import {
  activeWorktrees,
  beltPoint,
  lineLayout,
  seededRandom,
  shipmentProgress,
  syncShipments,
  type Shipment,
} from "./production-line";
import { buildProductionScene } from "./production-scene";

const target: Checkout = {
  id: "tree",
  taskId: "task",
  source: false,
  branch: "feature/a",
  path: "/tree",
  head: "abc",
};
const task: Task = {
  id: "task",
  title: "A",
  status: "working",
  workspace: "/repo",
  directory: "/tree",
  sessionId: "s",
  model: "m",
  checkouts: [],
};
const call: ToolActivity = {
  id: "call",
  taskId: "task",
  name: "edit",
  status: "running",
  detail: "a.rs",
  observedAt: 1000,
};

describe("procedural production lines", () => {
  it.each(["working", "needs-you", "publishing"])(
    "keeps %s agents but excludes source and unowned branches",
    (status) => {
      expect(
        activeWorktrees(
          [
            target,
            { ...target, id: "source", source: true },
            { ...target, id: "unowned", taskId: null },
          ],
          [{ ...task, status }],
        ),
      ).toEqual([target]);
    },
  );
  it.each([
    "review",
    "failed",
    "stopped",
    "interrupted",
    "removed",
    "allocating",
    "removing",
  ])("does not build stations for %s history", (status) => {
    expect(activeWorktrees([target], [{ ...task, status }])).toEqual([]);
  });
  it("generates deterministic variation, with independent seeds", () => {
    const a = seededRandom("project:tree"),
      b = seededRandom("project:tree"),
      c = seededRandom("project:other");
    const values = Array.from({ length: 10 }, a);
    expect(values).toEqual(Array.from({ length: 10 }, b));
    expect(values).not.toEqual(Array.from({ length: 10 }, c));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
  it("grows a single connected belt with continuous seams", () => {
    const layout = lineLayout(8);
    expect(layout.stations).toHaveLength(8);
    expect(layout.length).toBeGreaterThan(lineLayout(2).length);
    for (const seam of [
      0,
      layout.half * 2,
      layout.half * 2 + Math.PI * layout.radius,
      layout.half * 4 + Math.PI * layout.radius,
    ]) {
      const before = beltPoint(seam - 0.0001, layout),
        after = beltPoint(seam + 0.0001, layout);
      expect(Math.hypot(before.x - after.x, before.z - after.z)).toBeLessThan(
        0.001,
      );
    }
    expect(beltPoint(0, layout)).toEqual(beltPoint(layout.length, layout));
    const scratch = { x: 0, z: 0, angle: 0 };
    expect(beltPoint(2, layout, scratch)).toBe(scratch);
  });
  it("has one shipment per call and never replays recorded completions", () => {
    const shipments = new Map<string, Shipment>();
    syncShipments(
      shipments,
      [{ ...call, status: "completed", observedAt: null }],
      new Set(["task"]),
      0,
      1000,
    );
    expect(shipments.size).toBe(0);
    syncShipments(shipments, [call], new Set(["task"]), 0, 1000);
    const shipment = shipments.get("call")!;
    expect(shipmentProgress(shipment, 2000)).toBe(0.12);
    syncShipments(
      shipments,
      [{ ...call, status: "completed" }],
      new Set(["task"]),
      2000,
      1100,
    );
    expect(shipmentProgress(shipment, 5250)).toBeCloseTo(0.56);
    expect(shipmentProgress(shipment, 9000)).toBe(1);
    syncShipments(
      shipments,
      [{ ...call, status: "completed" }],
      new Set(["task"]),
      10000,
      1200,
    );
    expect(shipments.size).toBe(1);
    expect(shipments.get("call")).toBe(shipment);
    expect(shipmentProgress(shipment, 10000)).toBe(1);
  });
  it("handles fast failures, pause clocks, and removed worktrees", () => {
    const shipments = new Map<string, Shipment>();
    syncShipments(
      shipments,
      [{ ...call, status: "error" }],
      new Set(["task"]),
      30,
      1100,
    );
    const shipment = shipments.get("call")!;
    expect(shipment.status).toBe("error");
    expect(shipmentProgress(shipment, 30)).toBe(0);
    syncShipments(
      shipments,
      [{ ...call, status: "error" }],
      new Set(["task"]),
      30,
      2000,
    );
    expect(shipmentProgress(shipment, 30)).toBe(0);
    syncShipments(shipments, [call], new Set(), 30, 3000);
    expect(shipments.size).toBe(0);
  });
  it.each(["factory", "kitchen"] as const)(
    "batches %s geometry, retains a bounded pool and disposes resources",
    (theme) => {
      const targets = Array.from({ length: 8 }, (_, i) => ({
        ...target,
        id: String(i),
        taskId: `task-${i}`,
      }));
      const model = buildProductionScene(targets, theme, "test-seed");
      expect(model.stations).toHaveLength(8);
      expect(model.pickables).toHaveLength(8);
      const geometries = new Set<THREE.BufferGeometry>();
      let meshes = 0;
      model.root.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          meshes++;
        }
      });
      expect(geometries.size).toBeLessThanOrEqual(3);
      expect(meshes).toBeLessThan(60);
      model.writeShipment(299, 0, 1, 0, new THREE.Color("#168bff"));
      model.finishShipments(300);
      const dispose = [...geometries].map((geometry) =>
        vi.spyOn(geometry, "dispose"),
      );
      model.dispose();
      for (const spy of dispose) expect(spy).toHaveBeenCalledOnce();
    },
  );
});
