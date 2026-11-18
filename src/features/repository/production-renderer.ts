import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Checkout } from "../../shared/types";
import type { Visualization } from "../../shared/visualization";
import type { ToolActivity } from "./hooks/useToolActivity";
import {
  beltPoint,
  seedHash,
  shipmentProgress,
  syncShipments,
  toolColor,
  type Shipment,
} from "./production-line";
import { buildProductionScene } from "./production-scene";

export interface ProductionState {
  targets: Checkout[];
  calls: ToolActivity[];
  visualization: Visualization;
  seed: string;
  selected?: string;
  choose: (id: string) => void;
  paused: boolean;
}

export function createProductionRenderer(
  host: HTMLDivElement,
  labels: Map<string, HTMLButtonElement>,
  onUnavailable: () => void,
) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor("#f4f8ff");
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8eabc8, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(-8, 16, 10);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.normalBias = 0.035;
  light.shadow.bias = -0.0001;
  light.shadow.intensity = 0.3;
  scene.add(light, light.target);
  const camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.5, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.enablePan = true;
  controls.minPolarAngle = Math.PI / 7;
  controls.maxPolarAngle = Math.PI / 2.4;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const shipments = new Map<string, Shipment>();
  let state: ProductionState;
  let model: ReturnType<typeof buildProductionScene> | undefined;
  let layoutKey = "";
  let frame = 0,
    last = 0,
    clock = 0,
    width = 0,
    height = 0;
  let disposed = false,
    inView = true,
    labelsDirty = true;
  let moving: {
    shipment: Shipment;
    x: number;
    color: THREE.Color;
    lane: number;
  }[] = [];
  const projected = new THREE.Vector3();
  const point = { x: 0, z: 0, angle: 0 };
  const stats = {
    frames: 0,
    drawCalls: 0,
    geometries: 0,
    triangles: 0,
    shipments: 0,
    clock: 0,
    seed: "",
  };
  if (import.meta.env.DEV) Object.assign(host, { productionStats: stats });

  function schedule() {
    if (!frame && !disposed && inView && !document.hidden)
      frame = requestAnimationFrame(render);
  }
  function render(time: number) {
    frame = 0;
    if (disposed || !model || !inView || document.hidden) {
      last = 0;
      return;
    }
    const animate = !state.paused && !motion.matches;
    if (animate && last && time - last < 15) {
      schedule();
      return;
    }
    if (animate && last) clock += Math.min(time - last, 80);
    last = time;
    let active = false,
      count = 0;
    const kitchen = state.visualization === "kitchen";
    for (const item of moving) {
      // Reduced motion communicates terminal states in the feed instead of
      // leaving frozen completed plates on the belt indefinitely.
      if (motion.matches && item.shipment.status !== "running") continue;
      const progress = shipmentProgress(item.shipment, clock);
      if (progress >= 1) continue;
      active = true;
      let x = item.x + item.lane,
        z: number,
        y = kitchen ? 1.16 : 1.02;
      if (progress <= 0.12)
        z =
          (kitchen ? 0.85 : -0.5) + (progress / 0.12) * (kitchen ? 0.8 : 2.15);
      else if (
        item.shipment.status === "error" ||
        item.shipment.status === "interrupted"
      ) {
        z = 1.65 + ((progress - 0.12) / 0.88) * 1.6;
        y -= ((progress - 0.12) / 0.88) * 0.7;
      } else if (kitchen) {
        beltPoint(
          item.x +
            model.layout.half +
            ((progress - 0.12) / 0.88) * model.layout.length,
          model.layout,
          point,
        );
        x = point.x;
        z = point.z;
      } else {
        x =
          item.x +
          ((model.layout.half + 2.25 - item.x) * (progress - 0.12)) / 0.88;
        z = 1.65 + item.lane;
      }
      model.writeShipment(count++, x, y, z, item.color);
    }
    model.finishShipments(count);
    for (const station of model.stations) {
      const work = !motion.matches && station.running;
      station.actor.position.y =
        0.1 +
        (work
          ? Math.sin(clock / (kitchen ? 180 : 300)) * (kitchen ? 0.035 : 0.15)
          : 0);
      station.actor.rotation.y =
        work && kitchen ? Math.sin(clock / 500) * 0.15 : 0;
      active ||= station.running;
    }
    if (labelsDirty) {
      camera.updateMatrixWorld();
      for (const station of model.stations) {
        projected.copy(station.anchor).project(camera);
        const label = labels.get(station.target.id);
        if (label) {
          label.style.transform = `translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px) translate(-50%, -100%)`;
          label.style.visibility =
            Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1
              ? "hidden"
              : "visible";
        }
      }
      labelsDirty = false;
    }
    renderer.render(scene, camera);
    if (import.meta.env.DEV) {
      stats.frames++;
      stats.drawCalls = renderer.info.render.calls;
      stats.geometries = renderer.info.memory.geometries;
      stats.triangles = renderer.info.render.triangles;
      stats.shipments = count;
      stats.clock = clock;
    }
    if (animate && active) schedule();
    else last = 0;
  }
  function cameraChanged() {
    labelsDirty = true;
    schedule();
  }
  function resize() {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height || !model) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height);
    const aspect = width / height;
    // Reserve room below the miniature for the embedded activity feed.
    const span = Math.max(12, (model.width * 0.94 + 4) / aspect);
    camera.left = (-span * aspect) / 2;
    camera.right = (span * aspect) / 2;
    camera.top = span * 0.43;
    camera.bottom = -span * 0.57;
    camera.updateProjectionMatrix();
    cameraChanged();
  }
  function reset() {
    if (!model) return;
    controls.target.set(model.center, 0.65, 0);
    camera.position.set(model.center + 7, 12, 15);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.update();
    resize();
  }
  function suspend() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    schedule();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const visibility = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    suspend();
  });
  visibility.observe(host);
  document.addEventListener("visibilitychange", suspend);
  motion.addEventListener("change", suspend);
  controls.addEventListener("change", cameraChanged);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerX = 0,
    pointerY = 0;
  const down = (event: PointerEvent) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  };
  const up = (event: PointerEvent) => {
    if (
      !model ||
      Math.hypot(event.clientX - pointerX, event.clientY - pointerY) > 5
    )
      return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(model.pickables, false)[0];
    if (hit) state.choose(hit.object.userData.checkoutId);
  };
  const lost = (event: Event) => {
    event.preventDefault();
    disposed = true;
    cancelAnimationFrame(frame);
    onUnavailable();
  };
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  return {
    reset,
    update(next: ProductionState) {
      if (disposed) return;
      const key = JSON.stringify([
        next.visualization,
        next.seed,
        next.targets.map((target) => [target.id, target.taskId]),
      ]);
      const changed = key !== layoutKey;
      const pauseChanged = state?.paused !== next.paused;
      state = next;
      if (changed) {
        const first = !model;
        if (model) {
          scene.remove(model.root);
          model.dispose();
        }
        model = buildProductionScene(
          next.targets,
          next.visualization,
          next.seed,
        );
        scene.add(model.root);
        layoutKey = key;
        const size = model.width + 10;
        Object.assign(light.shadow.camera, {
          left: -size,
          right: size,
          top: size,
          bottom: -size,
          far: size * 4,
        });
        light.shadow.camera.updateProjectionMatrix();
        light.position.set(model.center - 8, size + 8, 10);
        light.target.position.set(model.center, 0, 0);
        renderer.shadowMap.needsUpdate = true;
        if (first) reset();
        else resize();
        stats.seed = String(seedHash(next.seed));
      }
      if (!model) return;
      const byTask = new Map(
        model.stations.map((station) => [station.target.taskId!, station]),
      );
      syncShipments(
        shipments,
        next.calls,
        new Set(byTask.keys()),
        clock,
        Date.now(),
      );
      moving = [];
      for (const station of model.stations) {
        station.running = false;
        station.selection.visible = station.target.id === next.selected;
      }
      for (const shipment of shipments.values()) {
        const station = byTask.get(shipment.taskId);
        if (!station) continue;
        station.running ||= shipment.status === "running";
        moving.push({
          shipment,
          x: station.x,
          color: new THREE.Color(toolColor(shipment.name, shipment.status)),
          lane: ((seedHash(shipment.id) % 3) - 1) * 0.17,
        });
      }
      if (pauseChanged) last = 0;
      labelsDirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", suspend);
      motion.removeEventListener("change", suspend);
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      model?.dispose();
      light.shadow.map?.dispose();
      light.shadow.mapPass?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      if (import.meta.env.DEV) Reflect.deleteProperty(host, "productionStats");
    },
  };
}
