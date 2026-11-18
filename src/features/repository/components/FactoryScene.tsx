import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Checkout } from "../../../shared/types";
import type { ToolActivity } from "../hooks/useToolActivity";
import type { Visualization } from "../../../shared/visualization";

export const toolColor = (name: string, status = "") =>
  status === "error"
    ? "#d65f56"
    : /edit|write|patch/.test(name)
      ? "#60a580"
      : /read|search|grep|glob|list/.test(name)
        ? "#649ec5"
        : /bash|shell|exec|test/.test(name)
          ? "#d6a150"
          : "#a28abd";

export default function FactoryScene({
  visualization,
  targets,
  calls,
  selected,
  choose,
  paused,
}: {
  visualization: Visualization;
  targets: Checkout[];
  calls: ToolActivity[];
  selected?: string;
  choose: (id: string) => void;
  paused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const current = useRef({ calls, selected, choose, paused });
  current.current = { calls, selected, choose, paused };
  const redraw = useRef(() => {});
  const reset = useRef(() => {});
  const [unavailable, setUnavailable] = useState(false);
  const layoutKey = JSON.stringify(
    targets.map((t) => [t.id, t.taskId, t.source]),
  );

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const kitchen = visualization === "kitchen";
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-12, 12, 9, -9, 0.1, 150);
    const columns = Math.min(3, Math.max(1, targets.length));
    const rows = Math.max(1, Math.ceil(targets.length / columns));
    const width = columns * 6 + 2;
    const depth = rows * 7 + 2;
    const center = new THREE.Vector3(0, 0, 1);
    camera.position.set(17, 16, 21);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.minPolarAngle = Math.PI / 6;
    controls.maxPolarAngle = Math.PI / 2.7;
    controls.minZoom = 0.65;
    controls.maxZoom = 2.5;
    controls.update();
    scene.add(new THREE.HemisphereLight(0xfffaf0, 0x9caeab, 2.8));
    const sun = new THREE.DirectionalLight(0xfff0d7, 3.2);
    sun.position.set(-8, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -width,
      right: width,
      top: depth,
      bottom: -depth,
      far: 70,
    });
    sun.shadow.normalBias = 0.04;
    sun.shadow.bias = -0.0001;
    sun.shadow.radius = 4;
    scene.add(sun);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    function material(color: string) {
      if (!materials.has(color))
        materials.set(
          color,
          new THREE.MeshStandardMaterial({
            color,
            roughness: 0.85,
            flatShading: true,
          }),
        );
      return materials.get(color)!;
    }
    const cube = new THREE.BoxGeometry(1, 1, 1);
    geometries.add(cube);
    function box(
      parent: THREE.Object3D,
      size: number[],
      position: number[],
      color: string,
    ) {
      const mesh = new THREE.Mesh(cube, material(color));
      mesh.scale.set(size[0], size[1], size[2]);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }
    function cylinder(
      parent: THREE.Object3D,
      radius: number,
      height: number,
      position: number[],
      color: string,
      top = radius,
    ) {
      const geometry = new THREE.CylinderGeometry(top, radius, height, 10);
      geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, material(color));
      mesh.position.set(position[0], position[1], position[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }
    function tree(parent: THREE.Object3D, x: number, z: number, scale = 1) {
      cylinder(parent, 0.07, 0.65 * scale, [x, 0.35 * scale, z], "#977858");
      const geometry = new THREE.IcosahedronGeometry(0.55 * scale, 0);
      geometries.add(geometry);
      const leaf = new THREE.Mesh(geometry, material("#98af76"));
      leaf.position.set(x, 1.05 * scale, z);
      leaf.scale.y = 1.4;
      leaf.castShadow = true;
      parent.add(leaf);
    }
    box(scene, [width, 0.3, depth], [0, -0.28, 1], "#b0bdb4");
    box(scene, [width - 0.12, 0.08, depth - 0.12], [0, -0.09, 1], "#dce4d9");
    const ground = box(
      scene,
      [200, 0.1, 200],
      [0, -0.65, 0],
      kitchen ? "#eee2cf" : "#edf0e9",
    );
    ground.castShadow = false;
    const stations: {
      target: Checkout;
      group: THREE.Group;
      beacon: THREE.Mesh;
      selection: THREE.Mesh;
      parcels: THREE.Mesh[];
      smoke: THREE.Mesh[];
      anchor: THREE.Vector3;
      chef?: THREE.Group;
    }[] = [];
    targets.forEach((target, index) => {
      const group = new THREE.Group();
      group.position.set(
        ((index % columns) - (columns - 1) / 2) * 6,
        0,
        (Math.floor(index / columns) - (rows - 1) / 2) * 7,
      );
      group.userData.checkoutId = target.id;
      scene.add(group);
      if (kitchen) {
        const accent = ["#83b8ad", "#e7a36c", "#94a9cd"][index % 3];
        box(group, [5.4, 0.28, 6.1], [0, 0.07, 0.65], "#aa8770");
        for (let x = 0; x < 6; x++)
          for (let z = 0; z < 7; z++)
            box(
              group,
              [0.86, 0.05, 0.83],
              [-2.18 + x * 0.87, 0.24, -1.92 + z * 0.84],
              (x + z) % 2 ? "#efe7d4" : "#b3c9bc",
            );
        box(group, [5.4, 1.65, 0.16], [0, 1.02, -2.35], "#efd6b1");
        box(group, [0.16, 1.65, 6.1], [-2.7, 1.02, 0.65], "#efd6b1");
        box(group, [5.5, 0.12, 0.22], [0, 1.86, -2.35], "#c5946f");
        box(group, [0.22, 0.12, 6.1], [-2.7, 1.86, 0.65], "#c5946f");
        for (let x = -2; x <= 2; x += 0.5) {
          box(group, [0.01, 0.65, 0.02], [x, 1.15, -2.25], "#e0c49f");
          box(group, [0.48, 0.025, 0.02], [x, 1.2, -2.24], "#e0c49f");
        }
        for (const x of [-1.75, -0.58, 0.59, 1.76]) {
          box(group, [1.12, 0.85, 0.92], [x, 0.72, -1.72], accent);
          box(group, [1.2, 0.12, 1.04], [x, 1.2, -1.72], "#fcf2d9");
          box(group, [0.9, 0.5, 0.035], [x, 0.76, -1.23], "#d9e3ce");
          box(group, [0.35, 0.045, 0.06], [x, 1, -1.16], "#b48e66");
        }
        // Oven and pot, chopping board, sink, and a stocked pantry.
        box(group, [0.93, 0.55, 0.1], [-1.75, 0.76, -1.17], "#475b5b");
        box(group, [0.72, 0.31, 0.04], [-1.75, 0.73, -1.1], "#819396");
        for (const x of [-1.95, -1.55])
          for (const z of [-1.95, -1.5])
            cylinder(group, 0.16, 0.03, [x, 1.28, z], "#53686a");
        cylinder(group, 0.27, 0.33, [-1.75, 1.44, -1.72], "#889b9c");
        cylinder(group, 0.24, 0.03, [-1.75, 1.62, -1.72], "#dd8652");
        for (const x of [-2.08, -1.42])
          box(group, [0.15, 0.06, 0.12], [x, 1.51, -1.72], "#475b5b");
        box(group, [0.77, 0.06, 0.58], [-0.58, 1.3, -1.7], "#caa475");
        for (const x of [-0.8, -0.57, -0.34])
          cylinder(group, 0.085, 0.13, [x, 1.4, -1.7], "#d9734f");
        box(group, [0.19, 0.02, 0.4], [-0.4, 1.36, -1.84], "#b2c2bf");
        box(group, [0.07, 0.04, 0.22], [-0.4, 1.36, -1.54], "#6b685d");
        box(group, [0.83, 0.05, 0.65], [0.59, 1.27, -1.72], "#7b999c");
        box(group, [0.63, 0.02, 0.45], [0.59, 1.3, -1.72], "#b2d8d1");
        cylinder(group, 0.045, 0.4, [0.59, 1.48, -2.04], "#98a8a2");
        box(group, [0.28, 0.07, 0.07], [0.7, 1.66, -2.04], "#98a8a2");
        for (const y of [0.65, 1.32]) {
          box(group, [0.85, 0.1, 1.45], [-2.13, y, 0.2], "#bb8d63");
          for (const z of [-0.2, 0.2, 0.6])
            cylinder(
              group,
              0.13,
              0.28,
              [-2.13, y + 0.2, z],
              y > 1 ? "#b5bd77" : "#d59469",
            );
        }
        for (const z of [-0.35, 0.75])
          box(group, [0.08, 1.2, 0.08], [-2.5, 0.86, z], "#bb8d63");
        box(group, [2.65, 0.9, 0.95], [0.6, 0.74, 2.45], accent);
        box(group, [2.8, 0.14, 1.08], [0.6, 1.25, 2.45], "#fcf2d9");
        for (const x of [-0.3, 0.6, 1.5]) {
          cylinder(group, 0.28, 0.04, [x, 1.35, 2.45], "#ffffff");
          cylinder(group, 0.2, 0.015, [x, 1.38, 2.45], "#e1e6d9");
        }
        box(group, [0.09, 1.45, 0.09], [2.2, 1, -1.8], "#9d775a");
        const beacon = box(
          group,
          [0.52, 0.42, 0.08],
          [2.2, 1.64, -1.8],
          "#e9c36b",
        );
        const chef = new THREE.Group();
        chef.position.set(0.55, 0.27, 0.35);
        group.add(chef);
        for (const x of [-0.15, 0.15]) {
          box(chef, [0.2, 0.22, 0.31], [x, 0.12, 0.05], "#4d5f61");
          cylinder(chef, 0.1, 0.29, [x, 0.34, 0], "#536c79");
        }
        cylinder(chef, 0.32, 0.53, [0, 0.64, 0], "#fff7e7", 0.25);
        box(chef, [0.43, 0.4, 0.1], [0, 0.65, 0.27], accent);
        cylinder(chef, 0.25, 0.38, [0, 1.05, 0], "#e2af83");
        for (const x of [-0.1, 0.1])
          box(chef, [0.045, 0.065, 0.035], [x, 1.1, 0.24], "#435557");
        cylinder(chef, 0.32, 0.15, [0, 1.31, 0], "#fffbed");
        for (const x of [-0.16, 0, 0.16])
          cylinder(chef, 0.2, 0.27, [x, 1.5, 0], "#fffbed", 0.16);
        for (const x of [-0.38, 0.38]) {
          cylinder(chef, 0.12, 0.25, [x, 0.75, 0.05], "#fff7e7");
          cylinder(chef, 0.1, 0.15, [x, 0.64, 0.1], "#e2af83");
        }
        const parcels = Array.from({ length: 5 }, () => {
          const dish = cylinder(
            group,
            0.22,
            0.08,
            [0.65, 1.42, 2.45],
            "#d6a150",
          );
          cylinder(dish, 0.28, 0.035, [0, -0.05, 0], "#fffbed");
          dish.castShadow = false;
          dish.visible = false;
          return dish;
        });
        const smoke = Array.from({ length: 3 }, () => {
          const geometry = new THREE.IcosahedronGeometry(0.12, 0);
          geometries.add(geometry);
          const puff = new THREE.Mesh(geometry, material("#fff9e9"));
          puff.visible = false;
          group.add(puff);
          return puff;
        });
        const selection = box(
          group,
          [5.4, 0.04, 0.07],
          [0, 0.3, 3.73],
          "#588876",
        );
        stations.push({
          target,
          group,
          beacon,
          selection,
          parcels,
          smoke,
          chef,
          anchor: new THREE.Vector3(
            group.position.x,
            0.2,
            group.position.z + 4.15,
          ),
        });
        return;
      }
      const wall = target.source
        ? "#aabfc0"
        : ["#e9ad79", "#e8c486", "#9ebcb0"][(index - 1 + 3) % 3];
      const trim = target.source ? "#c2d0cb" : "#f7d7a8";
      box(group, [5.4, 0.15, 6.15], [0, 0.01, 0.65], "#ced2c7");
      for (let x = -2; x <= 2; x++)
        box(group, [0.012, 0.006, 6], [x, 0.09, 0.65], "#bbc2b8");
      for (let z = -2; z <= 3; z++)
        box(group, [5.3, 0.006, 0.012], [0, 0.09, z], "#bbc2b8");
      const selection = box(
        group,
        [5.5, 0.05, 0.07],
        [0, 0.12, 3.73],
        "#588876",
      );
      box(group, [3.4, 2.6, 2.5], [0, 1.4, -0.45], wall);
      box(group, [3.5, 0.16, 2.6], [0, 2.72, -0.45], trim);
      box(group, [3.18, 0.08, 2.3], [0, 2.84, -0.45], "#7d8580");
      for (const x of [-1.65, 1.65])
        box(group, [0.12, 0.25, 2.55], [x, 2.95, -0.45], trim);
      for (const z of [-1.65, 0.75])
        box(group, [3.4, 0.25, 0.12], [0, 2.95, z], trim);
      // Recessed factory windows with metal mullions, on both visible facades.
      for (const x of [-0.85, 0.85]) {
        box(group, [1.32, 0.75, 0.07], [x, 2.12, 0.835], "#4e5e5e");
        box(group, [1.18, 0.59, 0.08], [x, 2.14, 0.875], "#b5ced0");
        for (const dx of [-0.38, 0, 0.38])
          box(group, [0.035, 0.62, 0.04], [x + dx, 2.14, 0.93], "#697875");
        box(group, [1.24, 0.04, 0.04], [x, 2.14, 0.93], "#697875");
      }
      box(group, [0.07, 0.75, 1.8], [1.72, 2.12, -0.45], "#4e5e5e");
      box(group, [0.08, 0.59, 1.64], [1.76, 2.14, -0.45], "#b5ced0");
      for (let z = -1; z < 0.4; z += 0.4)
        box(group, [0.04, 0.62, 0.035], [1.81, 2.14, z], "#697875");
      box(group, [0.04, 0.04, 1.7], [1.81, 2.14, -0.45], "#697875");
      box(group, [1.25, 1.35, 0.12], [0.65, 0.82, 0.84], "#465856");
      box(group, [1.05, 1.15, 0.14], [0.65, 0.76, 0.9], "#65716a");
      for (let y = 0.3; y < 1.4; y += 0.17)
        box(group, [1.06, 0.025, 0.03], [0.65, y, 0.985], "#4c5c55");
      box(group, [0.55, 1.15, 0.12], [-1, 0.72, 0.85], "#536561");
      box(group, [0.07, 0.07, 0.07], [-0.84, 0.76, 0.94], "#dfd9bd");
      box(group, [0.8, 0.1, 0.42], [-1, 0.17, 1.08], "#e1cfb1");
      cylinder(group, 0.26, 1.6, [-0.98, 3.6, -0.9], "#6e7771", 0.23);
      cylinder(group, 0.32, 0.12, [-0.98, 4.38, -0.9], "#59655e");
      cylinder(group, 0.31, 0.1, [-0.98, 3.38, -0.9], "#59655e");
      cylinder(group, 0.47, 0.95, [0.55, 3.36, -0.72], "#a5aaa0");
      cylinder(group, 0.52, 0.08, [0.55, 2.93, -0.72], "#66736b");
      cylinder(group, 0.49, 0.13, [0.55, 3.88, -0.72], "#bac0b4", 0.39);
      box(group, [0.8, 1.4, 1.5], [-2.05, 0.8, -0.7], wall);
      box(group, [0.95, 0.12, 1.65], [-2.05, 1.55, -0.7], "#87958a");
      cylinder(group, 0.065, 0.34, [1.33, 3.22, 0.28], "#5c6e60");
      const beacon = cylinder(group, 0.13, 0.18, [1.33, 3.43, 0.28], "#e9c36b");
      // The conveyor comes directly out of the loading bay.
      box(group, [1.15, 0.15, 2.8], [0.65, 0.55, 2.28], "#596d68");
      for (const x of [0.07, 1.23]) {
        box(group, [0.08, 0.17, 2.9], [x, 0.65, 2.28], "#91a7a0");
        for (const z of [1.3, 3.4])
          box(group, [0.08, 0.5, 0.08], [x, 0.3, z], "#788b80");
      }
      for (let z = 1; z < 3.65; z += 0.19) {
        const roller = cylinder(group, 0.07, 1, [0.65, 0.65, z], "#adb8ab");
        roller.rotation.z = Math.PI / 2;
      }
      const parcels = Array.from({ length: 5 }, () => {
        const parcel = box(
          group,
          [0.43, 0.4, 0.43],
          [0.65, 0.93, 2],
          "#d6a150",
        );
        box(parcel, [0.18, 0.025, 1.02], [0, 0.51, 0], "#f5e1b5");
        parcel.visible = false;
        parcel.castShadow = false;
        return parcel;
      });
      for (const z of [1.6, 2.1]) {
        box(group, [0.68, 0.09, 0.6], [-1.7, 0.19, z], "#b39a75");
        box(group, [0.51, 0.45, 0.48], [-1.7, 0.46, z], "#c7ae83");
        box(group, [0.1, 0.02, 0.49], [-1.7, 0.695, z], "#eddbaf");
      }
      tree(group, 2.13, -1.65, 0.85);
      tree(group, -2.05, 2.95, 0.7);
      box(group, [0.7, 0.3, 0.7], [2.13, 0.23, -1.65], "#b3b99f");
      for (const z of [2.95, 3.45]) {
        cylinder(group, 0.055, 0.45, [1.65, 0.32, z], "#d1a153");
        cylinder(group, 0.06, 0.1, [1.65, 0.48, z], "#f0e2b9");
      }
      const smoke = Array.from({ length: 3 }, () => {
        const geometry = new THREE.IcosahedronGeometry(0.2, 0);
        geometries.add(geometry);
        const puff = new THREE.Mesh(geometry, material("#d2d7cb"));
        puff.visible = false;
        group.add(puff);
        return puff;
      });
      const anchor = new THREE.Vector3(
        group.position.x,
        0.2,
        group.position.z + 4.15,
      );
      stations.push({
        target,
        group,
        beacon,
        selection,
        parcels,
        smoke,
        anchor,
      });
    });

    let frame = 0;
    let last = 0;
    let disposed = false;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const projected = new THREE.Vector3();
    function render(time = 0) {
      if (disposed || document.hidden) {
        frame = 0;
        return;
      }
      let moving = false;
      const { calls, selected, paused } = current.current;
      const animate = !paused && !motion.matches;
      camera.updateMatrixWorld();
      for (const station of stations) {
        const tools = calls.filter(
          (call) => call.taskId === station.target.taskId,
        );
        const running = tools.filter((call) => call.status === "running");
        const parcels = tools
          .filter(
            (call) =>
              call.status === "running" ||
              (call.observedAt !== null && Date.now() - call.observedAt < 5500),
          )
          .slice(0, 5);
        station.selection.visible = selected === station.target.id;
        station.beacon.material = material(
          running.length
            ? "#78ad82"
            : tools[0]?.status === "error"
              ? "#d65f56"
              : "#e9c36b",
        );
        station.parcels.forEach((mesh, i) => {
          const call = parcels[i];
          mesh.visible = !!call;
          if (!call) return;
          mesh.material = material(toolColor(call.name, call.status));
          const progress = animate
            ? (time / 4000 + i * 0.27) % 1
            : 0.25 + i * 0.13;
          if (kitchen) {
            mesh.position.x = -0.35 + progress * 1.9;
            mesh.position.z = 2.45;
          } else mesh.position.z = 1.1 + progress * 2.45;
        });
        station.smoke.forEach((puff, i) => {
          puff.visible = !!running.length;
          const progress = animate ? (time / 3600 + i / 3) % 1 : i / 3;
          puff.position.set(
            (kitchen ? -1.75 : -0.98) + progress * 0.35,
            (kitchen ? 1.75 : 4.55) + progress * 1.1,
            kitchen ? -1.72 : -0.9,
          );
          puff.scale.setScalar(0.45 + progress * 1.2);
        });
        if (animate && parcels.length) moving = true;
        if (station.chef) {
          station.chef.rotation.y =
            animate && running.length ? Math.sin(time / 650) * 0.35 : 0;
          station.chef.position.y =
            0.27 +
            (animate && running.length
              ? Math.abs(Math.sin(time / 200)) * 0.045
              : 0);
        }
        projected.copy(station.anchor).project(camera);
        const label = labels.current.get(station.target.id);
        if (label) {
          label.style.left = `${(projected.x * 0.5 + 0.5) * container!.clientWidth}px`;
          label.style.top = `${(-projected.y * 0.5 + 0.5) * container!.clientHeight}px`;
        }
      }
      renderer.render(scene, camera);
      frame = moving ? requestAnimationFrame(tick) : 0;
    }
    function tick(time: number) {
      frame = 0;
      if (time - last < 32) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = time;
      render(time);
    }
    function requestRender() {
      if (!frame && !disposed && !document.hidden)
        frame = requestAnimationFrame(tick);
    }
    redraw.current = requestRender;
    reset.current = () => {
      camera.position.set(17, 16, 21);
      camera.zoom = 1;
      controls.target.copy(center);
      controls.update();
      resize();
      requestRender();
    };
    function resize() {
      const w = container!.clientWidth,
        h = container!.clientHeight;
      if (!w || !h) return;
      const aspect = w / h;
      camera.updateMatrixWorld();
      const bounds = new THREE.Box3();
      for (const x of [-width / 2, width / 2])
        for (const y of [-0.5, kitchen ? 2.4 : 5.7])
          for (const z of [1 - depth / 2, 1 + depth / 2])
            bounds.expandByPoint(
              new THREE.Vector3(x, y, z).applyMatrix4(
                camera.matrixWorldInverse,
              ),
            );
      const span = Math.max(
        (bounds.max.y - bounds.min.y) * 1.28,
        ((bounds.max.x - bounds.min.x) * 1.12) / aspect,
      );
      const cx = (bounds.max.x + bounds.min.x) / 2;
      const cy = (bounds.max.y + bounds.min.y) / 2;
      camera.left = cx - (span * aspect) / 2;
      camera.right = cx + (span * aspect) / 2;
      camera.top = cy + span / 2;
      camera.bottom = cy - span / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    controls.addEventListener("change", requestRender);
    motion.addEventListener("change", requestRender);
    document.addEventListener("visibilitychange", requestRender);
    const raycaster = new THREE.Raycaster();
    let pointer = { x: 0, y: 0 };
    const down = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hits = raycaster.intersectObjects(
        stations.map((station) => station.group),
        true,
      );
      let object: THREE.Object3D | null = hits[0]?.object ?? null;
      while (object && !object.userData.checkoutId) object = object.parent;
      if (object) current.current.choose(object.userData.checkoutId);
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", up);
    const contextLost = (event: Event) => {
      event.preventDefault();
      disposed = true;
      cancelAnimationFrame(frame);
      setUnavailable(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    resize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      motion.removeEventListener("change", requestRender);
      document.removeEventListener("visibilitychange", requestRender);
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((value) => value.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      redraw.current = () => {};
      reset.current = () => {};
    };
  }, [layoutKey, visualization]);
  useEffect(() => {
    redraw.current();
    const recent = calls.filter(
      (call) =>
        call.status !== "running" &&
        call.observedAt !== null &&
        call.observedAt + 5500 > Date.now(),
    );
    const timers = recent.map((call) =>
      window.setTimeout(
        () => redraw.current(),
        Math.max(0, call.observedAt! + 5510 - Date.now()),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [calls, selected, paused]);

  return (
    <>
      <div
        ref={host}
        className="factory-canvas"
        aria-label={
          visualization === "kitchen"
            ? "Interactive low-poly worktree kitchen"
            : "Interactive low-poly worktree factory"
        }
      >
        {!unavailable &&
          targets.map((target, index) => (
            <button
              key={target.id}
              ref={(node) => {
                if (node) labels.current.set(target.id, node);
                else labels.current.delete(target.id);
              }}
              className="factory-building-label"
              aria-pressed={selected === target.id}
              onClick={() => choose(target.id)}
              title={target.branch}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {target.branch}
            </button>
          ))}
        {unavailable && (
          <div className="factory-webgl-fallback">
            3D rendering is unavailable. Use the checkout selector and activity
            feed.
          </div>
        )}
      </div>
      <button
        className="factory-reset"
        onClick={() => reset.current()}
        title="Reset camera"
        aria-label="Reset factory camera"
      >
        Reset view
      </button>
    </>
  );
}
