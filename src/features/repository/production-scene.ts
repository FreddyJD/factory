import * as THREE from "three";
import type { Checkout } from "../../shared/types";
import type { Visualization } from "../../shared/visualization";
import {
  beltPoint,
  lineLayout,
  seededRandom,
  stationColor,
} from "./production-line";

export function buildProductionScene(
  targets: Checkout[],
  theme: Visualization,
  seed: string,
) {
  const kitchen = theme === "kitchen";
  const layout = lineLayout(targets.length);
  const root = new THREE.Group();
  const scenery = new THREE.Group();
  root.add(scenery);
  const geometries = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    ball: new THREE.IcosahedronGeometry(1, 1),
  };
  const material = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const instances: THREE.InstancedMesh[] = [];
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const extraMaterials: THREE.Material[] = [];
  const white = "#ffffff",
    dark = "#27364d",
    steel = "#93a7bd";
  function shape(
    parent: THREE.Object3D,
    kind: keyof typeof geometries,
    size: number[],
    position: number[],
    color: string,
  ) {
    const mesh = new THREE.Mesh(geometries[kind], material);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.userData.tint = color;
    parent.add(mesh);
    return mesh;
  }
  function box(
    parent: THREE.Object3D,
    size: number[],
    position: number[],
    color: string,
  ) {
    return shape(parent, "box", size, position, color);
  }
  function cylinder(
    parent: THREE.Object3D,
    radius: number,
    height: number,
    position: number[],
    color: string,
  ) {
    return shape(parent, "cylinder", [radius, height, radius], position, color);
  }
  // Bake repeated primitives into three instance batches, including their colors.
  // Worktree-specific animated parts are batched locally, not into the static floor.
  function batch(group: THREE.Group, shadows: boolean) {
    group.updateMatrixWorld(true);
    const inverse = group.matrixWorld.clone().invert();
    for (const geometry of Object.values(geometries)) {
      const meshes: THREE.Mesh[] = [];
      group.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry === geometry)
          meshes.push(object);
      });
      if (!meshes.length) continue;
      const instanced = new THREE.InstancedMesh(
        geometry,
        material,
        meshes.length,
      );
      const matrix = new THREE.Matrix4();
      meshes.forEach((mesh, i) => {
        matrix.multiplyMatrices(inverse, mesh.matrixWorld);
        instanced.setMatrixAt(i, matrix);
        instanced.setColorAt(i, tint.set(mesh.userData.tint));
        mesh.removeFromParent();
      });
      instanced.castShadow = shadows;
      instanced.instanceMatrix.needsUpdate = true;
      instanced.instanceColor!.needsUpdate = true;
      instanced.receiveShadow = true;
      instanced.computeBoundingSphere();
      instanced.matrixAutoUpdate = false;
      group.add(instanced);
      instances.push(instanced);
    }
  }
  const floorWidth = layout.half * 2 + (kitchen ? 5.2 : 8);
  const floorCenter = kitchen ? 0 : 1.4;
  box(scenery, [floorWidth, 0.3, 8.6], [floorCenter, -0.2, 0], "#bdc9d8");
  box(
    scenery,
    [floorWidth - 0.1, 0.08, 8.5],
    [floorCenter, -0.01, 0],
    "#f6f9ff",
  );
  for (let x = -layout.half - 1.6; x < layout.half + 1.6; x += 0.8)
    for (let z = -3.2; z < 3.8; z += 0.8)
      box(
        scenery,
        [0.78, 0.025, 0.78],
        [x, 0.045, z],
        kitchen && Math.round((x + layout.half + 1.6 + z + 3.2) / 0.8) % 2
          ? "#d8efff"
          : "#ffffff",
      );

  const point = { x: 0, z: 0, angle: 0 };
  if (kitchen) {
    // One connected oval counter and belt, expanded parametrically with the crew.
    for (let d = 0; d < layout.length; d += 0.22) {
      beltPoint(d, layout, point);
      const base = box(
        scenery,
        [0.95, 0.9, 0.25],
        [point.x, 0.53, point.z],
        "#ef3340",
      );
      base.rotation.y = point.angle;
      const rail = box(
        scenery,
        [1.12, 0.12, 0.25],
        [point.x, 1.02, point.z],
        white,
      );
      rail.rotation.y = point.angle;
      const slat = box(
        scenery,
        [0.83, 0.07, 0.19],
        [point.x, 1.12, point.z],
        "#344760",
      );
      slat.rotation.y = point.angle;
    }
    box(
      scenery,
      [layout.half * 2 + 0.4, 0.65, 0.75],
      [0, 0.4, -0.4],
      "#00b998",
    );
    box(scenery, [layout.half * 2 + 0.6, 0.12, 0.88], [0, 0.79, -0.4], white);
    for (const x of layout.stations) {
      cylinder(scenery, 0.33, 0.12, [x, 0.72, 3.1], "#ef3340");
      cylinder(scenery, 0.065, 0.64, [x, 0.37, 3.1], steel);
      cylinder(scenery, 0.28, 0.06, [x, 0.08, 3.1], dark);
      box(scenery, [0.3, 0.12, 0.24], [x - 0.9, 1.05, 2.25], "#23946f");
      box(scenery, [0.04, 0.04, 0.48], [x - 0.75, 1.03, 2.25], "#b85c32");
      box(scenery, [0.04, 0.04, 0.48], [x - 0.65, 1.03, 2.25], "#b85c32");
    }
  } else {
    const beltLength = layout.half * 2 + 3.5;
    box(scenery, [beltLength, 0.3, 1.05], [0.75, 0.8, 1.65], dark);
    for (const z of [1.07, 2.23])
      box(scenery, [beltLength + 0.1, 0.16, 0.08], [0.75, 0.98, z], "#168bff");
    for (let x = -layout.half - 0.8; x < layout.half + 2.4; x += 0.24)
      box(scenery, [0.18, 0.05, 1.02], [x, 0.98, 1.65], steel);
    for (let x = -layout.half; x < layout.half + 2.4; x += 1.7)
      for (const z of [1.15, 2.15])
        box(scenery, [0.1, 0.7, 0.1], [x, 0.4, z], dark);
    // A compact delivery car at the single shared dispatch end.
    const car = new THREE.Group();
    car.position.set(layout.half + 3.3, 0, 1.65);
    scenery.add(car);
    box(car, [3, 0.5, 1.45], [0, 0.75, 0], "#ff3e53");
    box(car, [1.2, 0.6, 1.3], [0.3, 1.25, 0], "#ff3e53");
    box(car, [1.14, 0.37, 1.34], [0.3, 1.32, 0], "#88dbff");
    box(car, [1.3, 0.12, 1.4], [0.3, 1.6, 0], "#ff3e53");
    box(car, [0.7, 0.12, 1.2], [-1.03, 0.94, 0], dark);
    for (const z of [-0.76, 0.76])
      for (const x of [-0.95, 0.95]) {
        const tire = cylinder(car, 0.33, 0.2, [x, 0.43, z], "#202c42");
        tire.rotation.x = Math.PI / 2;
        const hub = cylinder(car, 0.16, 0.23, [x, 0.43, z], white);
        hub.rotation.x = Math.PI / 2;
      }
    for (const z of [-0.5, 0.5])
      box(car, [0.06, 0.18, 0.28], [1.52, 0.83, z], "#fff4af");
    box(car, [0.06, 0.14, 1.45], [1.54, 0.58, 0], white);
    for (let x = layout.half + 2; x < layout.half + 5; x += 0.5)
      box(scenery, [0.26, 0.025, 0.08], [x, 0.06, 3.1], "#168bff");
  }

  const pickables: THREE.Mesh[] = [];
  const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
  extraMaterials.push(pickMaterial);
  const stations = targets.map((target, i) => {
    const x = layout.stations[i];
    const color = stationColor(`${seed}:${target.id}`);
    const random = seededRandom(`${seed}:${target.id}`);
    const group = new THREE.Group();
    group.position.x = x;
    scenery.add(group);
    const actor = new THREE.Group();
    actor.position.set(x, 0.1, kitchen ? 0.25 : -0.6);
    root.add(actor);
    if (kitchen) {
      box(group, [1.15, 0.06, 0.54], [0, 0.89, -0.4], "#e4ad62");
      for (let n = 0; n < 3; n++) {
        cylinder(
          group,
          0.1,
          0.15,
          [-0.3 + n * 0.25, 1, -0.4],
          random() > 0.5 ? "#ff713b" : "#17bd74",
        );
      }
      cylinder(group, 0.25, 0.1, [1.08, 0.92, -0.4], white);
      cylinder(group, 0.18, 0.07, [1.08, 1, -0.4], "#243746");
      // One chef is one active worktree, not a second miniature building.
      for (const dx of [-0.16, 0.16])
        box(actor, [0.23, 0.2, 0.32], [dx, 0.12, 0.04], dark);
      cylinder(actor, 0.3, 0.57, [0, 0.55, 0], white);
      box(actor, [0.43, 0.4, 0.1], [0, 0.53, 0.27], color);
      const skin = ["#efbb90", "#ad714c", "#d79568"][Math.floor(random() * 3)];
      shape(actor, "ball", [0.29, 0.3, 0.27], [0, 1.02, 0], skin);
      cylinder(actor, 0.32, 0.12, [0, 1.29, 0], white);
      for (const dx of [-0.17, 0, 0.17])
        shape(actor, "ball", [0.22, 0.23, 0.22], [dx, 1.48, 0], white);
      for (const dx of [-0.1, 0.1])
        box(actor, [0.045, 0.06, 0.025], [dx, 1.07, 0.26], dark);
      box(actor, [0.14, 0.025, 0.025], [0, 0.96, 0.28], "#a84f4f");
      for (const dx of [-0.38, 0.38]) {
        shape(actor, "ball", [0.14, 0.18, 0.14], [dx, 0.65, 0.07], white);
        shape(actor, "ball", [0.11, 0.11, 0.11], [dx, 0.48, 0.2], skin);
      }
      box(actor, [0.04, 0.03, 0.55], [0.38, 0.5, 0.5], "#aabed2");
    } else {
      box(group, [2.4, 0.15, 2.8], [0, 0.15, -1.3], "#dce4ef");
      box(group, [2, 1.25, 1.3], [0, 0.87, -1.55], color);
      box(group, [2.1, 0.18, 1.4], [0, 1.59, -1.55], white);
      box(group, [1.5, 0.65, 0.06], [0, 0.91, -0.87], dark);
      box(group, [1.1, 0.07, 2], [0, 0.98, 0.05], steel);
      for (const dx of [-0.68, 0.68])
        box(group, [0.1, 1.4, 0.13], [dx, 1.6, -0.55], steel);
      box(group, [1.65, 0.2, 0.35], [0, 2.33, -0.55], color);
      box(actor, [1.1, 0.16, 0.75], [0, 1.4, 0], color);
      cylinder(actor, 0.11, 0.7, [0, 1.8, 0], steel);
      box(group, [0.32, 0.4, 0.07], [0.75, 1.22, -0.83], "#152b44");
      box(group, [0.22, 0.2, 0.03], [0.75, 1.27, -0.78], "#36e8cf");
      for (let n = 0; n < 3; n++)
        box(group, [0.22, 0.04, 0.04], [-0.77 + n * 0.25, 0.48, -0.85], white);
      for (let n = 0; n < 2; n++) {
        const height = 0.35 + random() * 0.22;
        box(
          group,
          [0.45, height, 0.45],
          [-0.6 + n * 0.65, 0.2 + height / 2, -2.7],
          "#ffba29",
        );
        box(
          group,
          [0.08, 0.02, 0.46],
          [-0.6 + n * 0.65, 0.21 + height, -2.7],
          white,
        );
      }
    }
    batch(actor, false);
    const selection = new THREE.Mesh(
      geometries.box,
      new THREE.MeshBasicMaterial({ color }),
    );
    extraMaterials.push(selection.material);
    selection.position.set(x, 0.08, kitchen ? 3.7 : -3.1);
    selection.scale.set(2.5, 0.03, 0.08);
    root.add(selection);
    const hit = new THREE.Mesh(geometries.box, pickMaterial);
    hit.position.set(x, 1.15, kitchen ? 0 : -1.2);
    hit.scale.set(2.7, 2.5, 2.3);
    hit.userData.checkoutId = target.id;
    root.add(hit);
    pickables.push(hit);
    return {
      target,
      x,
      actor,
      selection,
      running: false,
      anchor: new THREE.Vector3(x, kitchen ? 2 : 2.8, kitchen ? 0.25 : -1.2),
    };
  });
  batch(scenery, true);

  // A fixed-capacity GPU pool: every visible call has its own instance, not a
  // looping decorative parcel. Four draw calls at most, regardless of call count.
  const pieces = kitchen
    ? [
        {
          geometry: geometries.cylinder,
          size: [0.3, 0.045, 0.3],
          y: 0.03,
          color: "",
        },
        {
          geometry: geometries.box,
          size: [0.3, 0.14, 0.38],
          y: 0.12,
          color: white,
        },
        {
          geometry: geometries.box,
          size: [0.34, 0.09, 0.43],
          y: 0.235,
          color: "#ff764c",
        },
        {
          geometry: geometries.box,
          size: [0.1, 0.025, 0.44],
          y: 0.29,
          color: "#153c38",
        },
      ]
    : [
        {
          geometry: geometries.box,
          size: [0.43, 0.38, 0.43],
          y: 0.19,
          color: "",
        },
        {
          geometry: geometries.box,
          size: [0.09, 0.02, 0.44],
          y: 0.39,
          color: white,
        },
      ];
  const shipments = pieces.map((piece) => {
    const mesh = new THREE.InstancedMesh(piece.geometry, material, 300);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Only the moving pool bypasses culling; its transforms change every frame.
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.setColorAt(0, tint.set(white));
    mesh.instanceColor!.needsUpdate = true;
    root.add(mesh);
    instances.push(mesh);
    return { ...piece, mesh };
  });
  return {
    root,
    layout,
    stations,
    pickables,
    width: floorWidth,
    center: floorCenter,
    writeShipment(
      index: number,
      x: number,
      y: number,
      z: number,
      color: THREE.Color,
    ) {
      for (const piece of shipments) {
        dummy.position.set(x, y + piece.y, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(piece.size[0], piece.size[1], piece.size[2]);
        dummy.updateMatrix();
        piece.mesh.setMatrixAt(index, dummy.matrix);
        piece.mesh.setColorAt(
          index,
          piece.color ? tint.set(piece.color) : color,
        );
      }
    },
    finishShipments(count: number) {
      for (const piece of shipments) {
        piece.mesh.count = count;
        piece.mesh.instanceMatrix.needsUpdate = true;
        piece.mesh.instanceColor!.needsUpdate = true;
      }
    },
    dispose() {
      instances.forEach((mesh) => mesh.dispose());
      Object.values(geometries).forEach((geometry) => geometry.dispose());
      extraMaterials.forEach((value) => value.dispose());
      material.dispose();
    },
  };
}
