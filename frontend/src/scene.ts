/**
 * Three.js visualization layer for the city simulation dashboard.
 *
 * Converts backend graph/resident snapshots into 3D scene primitives, manages
 * animation/interpolation, and renders roads, vehicles, incidents, and weather.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const WEATHER_PRESETS: Record<string, {
  background: number;
  fog: number;
  sun: number;
  ambient: number;
  sceneLabel: string;
}> = {
  clear: { background: 0x141e30, fog: 0x141e30, sun: 1.2, ambient: 1.0, sceneLabel: "Clear" },
  rain: { background: 0x0f1620, fog: 0x0f1620, sun: 0.6, ambient: 0.7, sceneLabel: "Rain" },
  storm: { background: 0x0a0f18, fog: 0x0a0f18, sun: 0.4, ambient: 0.5, sceneLabel: "Storm" },
  snow: { background: 0x1a2030, fog: 0x1a2030, sun: 0.8, ambient: 0.9, sceneLabel: "Snow" },
};

const BUILDING_COLORS: Record<string, number> = {
  home: 0x3b82f6,
  work: 0xf59e0b,
  school: 0xa78bfa,
  leisure: 0x10b981,
};

const DEFAULT_BUILDING_COLOR = 0x2a3550;

interface ProjectedNode {
  node_id: string;
  x: number;
  y: number;
  sceneX: number;
  sceneZ: number;
}

interface SceneState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  ambientLight: THREE.HemisphereLight;
  sunLight: THREE.DirectionalLight;
  cityGroup: THREE.Group;
  roadsGroup: THREE.Group;
  alertsGroup: THREE.Group;
  vehiclesGroup: THREE.Group;
  atmosphereGroup: THREE.Group;
  buildingGeometry: THREE.BoxGeometry;
  nodeGeometry: THREE.CylinderGeometry;
  roadGeometry: THREE.BoxGeometry;
  vehicleGeometry: THREE.BoxGeometry;
  treeGeometry: THREE.ConeGeometry;
  treeTrunkGeometry: THREE.CylinderGeometry;
  alertGeometry: THREE.CylinderGeometry;
  weatherParticleGeometry: THREE.BoxGeometry;
  roadMaterials: { blocked: THREE.MeshStandardMaterial; congested: THREE.MeshStandardMaterial; stable: THREE.MeshStandardMaterial };
  vehicleMaterials: { car: THREE.MeshStandardMaterial; public_transport: THREE.MeshStandardMaterial; other: THREE.MeshStandardMaterial };
  alertMaterial: THREE.MeshStandardMaterial;
  weatherMaterials: { rain: THREE.MeshStandardMaterial; snow: THREE.MeshStandardMaterial };
  vehicleMeshes: THREE.Mesh[];
  roadMeshesById: Map<string, THREE.Mesh>;
  vehicleMeshesByKey: Map<string, THREE.Mesh>;
  weatherParticles: THREE.Mesh[];
  staticGraphSignature: string | null;
  currentWeatherKey: string | null;
  buildingsByNode: Map<string, string>;
}

let state: SceneState;
let getInterpolationAlpha: () => number;

/**
 * Project geographic node coordinates into normalized scene space.
 * Used by: updateScene() before road/building/vehicle mesh placement.
 */
function projectGraph(nodes: any[]): ProjectedNode[] {
  const xs = nodes.map((n: any) => n.x);
  const ys = nodes.map((n: any) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return nodes.map((n: any) => ({
    ...n,
    sceneX: ((n.x - minX) / (maxX - minX || 1) - 0.5) * 100,
    sceneZ: ((n.y - minY) / (maxY - minY || 1) - 0.5) * 100,
  }));
}

/**
 * Select road material variant from edge state.
 * Used by: upsertRoads() when creating/updating road meshes per tick.
 */
function roadMaterial(edge: any, materials: SceneState["roadMaterials"]): THREE.MeshStandardMaterial {
  if (edge.blocked) return materials.blocked;
  if (edge.congestion > 20) return materials.congested;
  return materials.stable;
}

/**
 * Evaluate quadratic Bézier point at interpolation parameter t.
 * Used by: animateVehicles() for smooth per-frame vehicle positions.
 */
function computeCurvePoint(cp: THREE.Vector3[], t: number): THREE.Vector3 {
  const inv = 1 - t;
  return new THREE.Vector3(
    inv * inv * cp[0].x + 2 * inv * t * cp[1].x + t * t * cp[2].x,
    inv * inv * cp[0].y + 2 * inv * t * cp[1].y + t * t * cp[2].y,
    inv * inv * cp[0].z + 2 * inv * t * cp[1].z + t * t * cp[2].z,
  );
}

/**
 * Evaluate normalized tangent on quadratic Bézier curve at t.
 * Used by: animateVehicles() to orient vehicle meshes along movement path.
 */
function computeCurveTangent(cp: THREE.Vector3[], t: number): THREE.Vector3 {
  return new THREE.Vector3(
    2 * (1 - t) * (cp[1].x - cp[0].x) + 2 * t * (cp[2].x - cp[1].x),
    2 * (1 - t) * (cp[1].y - cp[0].y) + 2 * t * (cp[2].y - cp[1].y),
    2 * (1 - t) * (cp[1].z - cp[0].z) + 2 * t * (cp[2].z - cp[1].z),
  ).normalize();
}

/**
 * Populate static building meshes around graph nodes.
 * Used by: updateScene() when static graph signature changes.
 */
function addBuildings(nodes: ProjectedNode[], buildingsByNode: Map<string, string>) {
  const palette = [0x2a3550, 0x1e2d48, 0x243050, 0x2c3858, 0x1a2844, 0x263856];
  nodes.forEach((node, index) => {
    const buildingType = buildingsByNode.get(node.node_id);
    const ringCount = 4 + (index % 3);
    for (let i = 0; i < ringCount; i++) {
      const angle = (Math.PI * 2 * i) / ringCount + index * 0.22;
      const radius = 7 + ((index + i) % 4) * 2.1;
      const width = 3 + ((index + i) % 3) * 1.4;
      const depth = 2.8 + ((index + i) % 2) * 1.2;
      const height = 4 + ((index * 5 + i * 7) % 20);
      const color = buildingType ? BUILDING_COLORS[buildingType] ?? DEFAULT_BUILDING_COLOR : palette[(index + i) % palette.length];
      const building = new THREE.Mesh(
        state.buildingGeometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.96, metalness: 0.02 }),
      );
      building.castShadow = true;
      building.receiveShadow = true;
      building.scale.set(width, height, depth);
      building.position.set(
        node.sceneX + Math.cos(angle) * radius,
        height / 2,
        node.sceneZ + Math.sin(angle) * radius,
      );
      building.rotation.y = angle * 0.72;
      state.cityGroup.add(building);
    }
  });
}

/**
 * Add decorative park clusters to improve scene readability.
 * Used by: updateScene() static-geometry rebuild path.
 */
function addParks(nodes: ProjectedNode[]) {
  nodes.forEach((node, index) => {
    if (index % 2 !== 0) return;
    const park = new THREE.Mesh(
      new THREE.CylinderGeometry(4.4, 5.4, 0.3, 6),
      new THREE.MeshStandardMaterial({ color: 0x1a3828, roughness: 1 }),
    );
    park.receiveShadow = true;
    park.position.set(node.sceneX - 5.5, 0.16, node.sceneZ + 5.2);
    state.cityGroup.add(park);

    for (let ti = 0; ti < 3; ti++) {
      const angle = (Math.PI * 2 * ti) / 3 + index * 0.4;
      const trunk = new THREE.Mesh(
        state.treeTrunkGeometry,
        new THREE.MeshStandardMaterial({ color: 0x3d2a1a, roughness: 1 }),
      );
      trunk.castShadow = true;
      trunk.position.set(park.position.x + Math.cos(angle) * 1.6, 0.75, park.position.z + Math.sin(angle) * 1.5);
      state.cityGroup.add(trunk);

      const crown = new THREE.Mesh(
        state.treeGeometry,
        new THREE.MeshStandardMaterial({ color: 0x1a4030, roughness: 1 }),
      );
      crown.castShadow = true;
      crown.position.set(trunk.position.x, 3.2, trunk.position.z);
      state.cityGroup.add(crown);
    }
  });
}

/**
 * Add node hub towers scaled by local resident load.
 * Used by: updateScene() static-geometry rebuild path.
 */
function addHubs(nodes: ProjectedNode[], residentsByNode: Map<string, number>) {
  nodes.forEach((node, index) => {
    const load = residentsByNode.get(node.node_id) || 0;
    const towerHeight = 5 + (index % 4) * 1.2 + Math.min(8, load / 35);
    const tower = new THREE.Mesh(
      state.nodeGeometry,
      new THREE.MeshStandardMaterial({
        color: load > 120 ? 0x3b82f6 : 0x4a5a80,
        roughness: 0.58,
        metalness: 0.12,
      }),
    );
    tower.castShadow = true;
    tower.receiveShadow = true;
    tower.scale.y = towerHeight / 3.5;
    tower.position.set(node.sceneX, towerHeight / 2 + 0.4, node.sceneZ);
    state.cityGroup.add(tower);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 1.6, 14),
      new THREE.MeshStandardMaterial({ color: 0x6080c0, roughness: 0.35, metalness: 0.18 }),
    );
    cap.castShadow = true;
    cap.position.set(node.sceneX, towerHeight + 1, node.sceneZ);
    state.cityGroup.add(cap);
  });
}

/**
 * Create/update/remove road meshes to mirror current edge set.
 * Used by: updateScene() on every applied simulation snapshot.
 */
function upsertRoads(edges: any[], nodeById: Map<string, ProjectedNode>) {
  const seen = new Set<string>();
  edges.forEach((edge: any) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    seen.add(edge.edge_id);

    let road = state.roadMeshesById.get(edge.edge_id);
    if (!road) {
      road = new THREE.Mesh(state.roadGeometry, roadMaterial(edge, state.roadMaterials));
      road.castShadow = true;
      road.receiveShadow = true;
      state.roadsGroup.add(road);
      state.roadMeshesById.set(edge.edge_id, road);
    }

    const dx = target.sceneX - source.sceneX;
    const dz = target.sceneZ - source.sceneZ;
    const length = Math.hypot(dx, dz);
    const width = Math.min(5.8, 1.8 + edge.congestion / 10);
    road.material = roadMaterial(edge, state.roadMaterials);
    road.scale.set(width, 1, length);
    road.position.set((source.sceneX + target.sceneX) / 2, 0.45, (source.sceneZ + target.sceneZ) / 2);
    road.rotation.y = Math.atan2(dx, dz);
  });

  for (const [edgeId, road] of state.roadMeshesById.entries()) {
    if (!seen.has(edgeId)) {
      state.roadsGroup.remove(road);
      state.roadMeshesById.delete(edgeId);
    }
  }
}

/**
 * Render active-event alert markers in the 3D scene.
 * Used by: updateScene() after roads are synchronized.
 */
function updateAlerts(events: any[], nodeById: Map<string, ProjectedNode>, edgeById: Map<string, any>) {
  state.alertsGroup.clear();
  events.forEach((event: any, index: number) => {
    const alert = new THREE.Mesh(state.alertGeometry, state.alertMaterial);
    alert.castShadow = true;

    let x = -20 + index * 6;
    let z = -20 + index * 4;

    const edgeId = event.payload?.edge_id;
    const nodeId = event.payload?.node_id;
    if (edgeId && edgeById.has(edgeId)) {
      const edge = edgeById.get(edgeId);
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (source && target) {
        x = (source.sceneX + target.sceneX) / 2;
        z = (source.sceneZ + target.sceneZ) / 2;
      }
    } else if (nodeId && nodeById.has(nodeId)) {
      const node = nodeById.get(nodeId)!;
      x = node.sceneX;
      z = node.sceneZ;
    }

    alert.position.set(x, 5.5, z);
    state.alertsGroup.add(alert);
  });
}

/**
 * Upsert vehicle meshes from moving residents plus congestion placeholders.
 * Used by: updateScene() to refresh animated traffic state.
 */
function addVehicles(
  residents: any[],
  edges: any[],
  edgeById: Map<string, any>,
  nodeById: Map<string, ProjectedNode>,
  vehicleCountEl: HTMLElement,
) {
  const seenKeys = new Set<string>();
  const moving = residents
    .filter((r: any) => r.moving_edge_id && edgeById.has(r.moving_edge_id))
    .sort((a: any, b: any) => String(a.resident_id).localeCompare(String(b.resident_id)));

  const edgeDemand = new Map<string, number>();
  moving.forEach((r: any) => {
    const eid = String(r.moving_edge_id);
    edgeDemand.set(eid, (edgeDemand.get(eid) || 0) + 1);
  });

  const toRender: any[] = moving.map((r: any, idx: number) => {
    const rid = String(r.resident_id || `${r.current_node_id}-${r.moving_edge_id}-${r.mode}-${idx}`);
    let hash = 0;
    for (let ci = 0; ci < rid.length; ci++) hash = (hash * 31 + rid.charCodeAt(ci)) % 997;
    return { edgeId: String(r.moving_edge_id), rep: r, lane: hash % 4, key: `resident:${rid}` };
  });

  edges.forEach((edge: any) => {
    const demand = edgeDemand.get(edge.edge_id) || 0;
    const synthNeeded = Math.max(0, Math.ceil((edge.congestion || 0) / 12) - Math.ceil(demand / 3));
    if (!synthNeeded) return;
    const source = nodeById.get(edge.source);
    if (!source) return;
    for (let i = 0; i < Math.min(6, synthNeeded); i++) {
      toRender.push({
        edgeId: edge.edge_id,
        rep: { mode: "car", moving_total_seconds: 1, moving_remaining_seconds: 1 },
        lane: i,
        key: `synthetic:${edge.edge_id}:${i}`,
      });
    }
  });

  vehicleCountEl.textContent = String(moving.length);

  toRender.forEach((v: any, index: number) => {
    const edge = edgeById.get(v.edgeId);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;

    const p0 = new THREE.Vector3(source.sceneX, 0.6, source.sceneZ);
    const p1 = new THREE.Vector3((source.sceneX + target.sceneX) / 2, 0.85, (source.sceneZ + target.sceneZ) / 2);
    const p2 = new THREE.Vector3(target.sceneX, 0.6, target.sceneZ);

    seenKeys.add(v.key);
    let mesh = state.vehicleMeshesByKey.get(v.key);
    if (!mesh) {
      const mat =
        v.rep.mode === "car" ? state.vehicleMaterials.car :
        v.rep.mode === "public_transport" ? state.vehicleMaterials.public_transport :
        state.vehicleMaterials.other;
      mesh = new THREE.Mesh(state.vehicleGeometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      state.vehiclesGroup.add(mesh);
      state.vehicleMeshesByKey.set(v.key, mesh);
    }

    const progress = v.rep.moving_total_seconds > 0
      ? 1 - v.rep.moving_remaining_seconds / v.rep.moving_total_seconds
      : ((index * 7) % 100) / 100;
    const nextOffset = Math.min(0.98, Math.max(0.02, progress + v.lane * 0.03));
    const prev = mesh.userData || {};
    const prevOffset = prev.edgeId === v.edgeId ? Number(prev.toOffset ?? prev.offset ?? nextOffset) : nextOffset;

    mesh.userData = {
      offset: nextOffset,
      fromOffset: prevOffset,
      toOffset: nextOffset,
      edgeId: v.edgeId,
      controlPoints: [p0, p1, p2],
    };
    mesh.position.y += (v.lane % 3) * 0.02;
  });

  for (const [key, mesh] of state.vehicleMeshesByKey.entries()) {
    if (!seenKeys.has(key)) {
      state.vehiclesGroup.remove(mesh);
      state.vehicleMeshesByKey.delete(key);
    }
  }
  state.vehicleMeshes = Array.from(state.vehicleMeshesByKey.values());
}

/**
 * Apply weather lighting/background and rebuild precipitation particles.
 * Used by: updateScene() to keep atmosphere synchronized with backend weather.
 */
function applyWeather(weather: string, sceneStateEl: HTMLElement) {
  const key = String(weather).toLowerCase();
  const preset = WEATHER_PRESETS[key] || WEATHER_PRESETS.clear;
  state.scene.background.setHex(preset.background);
  state.scene.fog.color.setHex(preset.fog);
  state.ambientLight.intensity = preset.ambient;
  state.sunLight.intensity = preset.sun;
  sceneStateEl.textContent = preset.sceneLabel;

  if (state.currentWeatherKey === key) return;
  state.currentWeatherKey = key;
  state.atmosphereGroup.clear();
  state.weatherParticles = [];

  if (preset === WEATHER_PRESETS.clear) return;

  const count = preset === WEATHER_PRESETS.snow ? 180 : 140;
  const mat = preset === WEATHER_PRESETS.snow ? state.weatherMaterials.snow : state.weatherMaterials.rain;

  for (let i = 0; i < count; i++) {
    const particle = new THREE.Mesh(state.weatherParticleGeometry, mat);
    particle.scale.y = preset === WEATHER_PRESETS.snow ? 0.15 : 1.4;
    particle.position.set((i % 18) * 7 - 62, 12 + (i % 16) * 3.1, Math.floor(i / 18) * 8 - 36);
    particle.userData.speed = preset === WEATHER_PRESETS.snow ? 0.08 + (i % 4) * 0.015 : 0.3 + (i % 5) * 0.03;
    state.atmosphereGroup.add(particle);
    state.weatherParticles.push(particle);
  }
}

/**
 * Initialize Three.js scene, controls, and animation loop.
 * Used by: frontend/src/main.ts at startup to create the 3D viewport.
 */
export function initScene(
  container: HTMLElement,
  alphaFn: () => number,
  sceneStateEl: HTMLElement,
  vehicleCountEl: HTMLElement,
) {
  getInterpolationAlpha = alphaFn;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141e30);
  scene.fog = new THREE.Fog(0x141e30, 190, 330);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
  camera.position.set(68, 82, 72);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 50;
  controls.maxDistance = 180;
  controls.maxPolarAngle = Math.PI / 2.08;
  controls.target.set(0, 8, 0);

  const ambientLight = new THREE.HemisphereLight(0x8090c0, 0x203040, 0.9);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xc0d0f0, 1.1);
  sunLight.position.set(38, 72, 16);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -90;
  sunLight.shadow.camera.right = 90;
  sunLight.shadow.camera.top = 90;
  sunLight.shadow.camera.bottom = -90;
  scene.add(sunLight);

  const ground = new THREE.Mesh(
    new THREE.CylinderGeometry(96, 112, 7, 8),
    new THREE.MeshStandardMaterial({ color: 0x0f1a2a, roughness: 1, metalness: 0 }),
  );
  ground.receiveShadow = true;
  ground.position.y = -3.6;
  scene.add(ground);

  const plaza = new THREE.Mesh(
    new THREE.CylinderGeometry(78, 84, 0.7, 8),
    new THREE.MeshStandardMaterial({ color: 0x162038, roughness: 0.95, metalness: 0 }),
  );
  plaza.receiveShadow = true;
  scene.add(plaza);

  const waterRing = new THREE.Mesh(
    new THREE.TorusGeometry(84, 8, 18, 100),
    new THREE.MeshStandardMaterial({ color: 0x0d2040, roughness: 0.78, metalness: 0.08 }),
  );
  waterRing.rotation.x = Math.PI / 2;
  waterRing.position.y = -2.2;
  scene.add(waterRing);

  const cityGroup = new THREE.Group();
  scene.add(cityGroup);
  const roadsGroup = new THREE.Group();
  scene.add(roadsGroup);
  const alertsGroup = new THREE.Group();
  scene.add(alertsGroup);
  const vehiclesGroup = new THREE.Group();
  scene.add(vehiclesGroup);
  const atmosphereGroup = new THREE.Group();
  scene.add(atmosphereGroup);

  state = {
    scene, camera, renderer, controls, ambientLight, sunLight,
    cityGroup, roadsGroup, alertsGroup, vehiclesGroup, atmosphereGroup,
    buildingGeometry: new THREE.BoxGeometry(1, 1, 1),
    nodeGeometry: new THREE.CylinderGeometry(1.65, 1.65, 3.5, 18),
    roadGeometry: new THREE.BoxGeometry(1, 0.9, 1),
    vehicleGeometry: new THREE.BoxGeometry(1.2, 0.8, 2.6),
    treeGeometry: new THREE.ConeGeometry(1.4, 4.4, 8),
    treeTrunkGeometry: new THREE.CylinderGeometry(0.22, 0.28, 1.2, 8),
    alertGeometry: new THREE.CylinderGeometry(0.35, 0.35, 10, 10),
    weatherParticleGeometry: new THREE.BoxGeometry(0.15, 1, 0.15),
    roadMaterials: {
      blocked: new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.74 }),
      congested: new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.72 }),
      stable: new THREE.MeshStandardMaterial({ color: 0x3b4a68, roughness: 0.82, metalness: 0.06 }),
    },
    vehicleMaterials: {
      car: new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.5, metalness: 0.15 }),
      public_transport: new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.5, metalness: 0.15 }),
      other: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.5, metalness: 0.15 }),
    },
    alertMaterial: new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x7f1d1d, roughness: 0.35, metalness: 0.08 }),
    weatherMaterials: {
      rain: new THREE.MeshStandardMaterial({ color: 0x6080a0, roughness: 0.45, transparent: true, opacity: 0.4 }),
      snow: new THREE.MeshStandardMaterial({ color: 0xd0d8e8, roughness: 0.45, transparent: true, opacity: 0.4 }),
    },
    vehicleMeshes: [],
    roadMeshesById: new Map(),
    vehicleMeshesByKey: new Map(),
    weatherParticles: [],
    staticGraphSignature: null,
    currentWeatherKey: null,
    buildingsByNode: new Map(),
  };

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  });
  ro.observe(container);
  ro.disconnect;

  renderer.setAnimationLoop(() => {
    controls.update();
    animateVehicles();
    animateWeather();
    renderer.render(scene, camera);
  });

  /**
   * Animate vehicle meshes between simulation snapshots.
   * Used by: initScene() render loop each animation frame.
   */
  function animateVehicles() {
    const alpha = getInterpolationAlpha();
    state.vehicleMeshes.forEach((mesh) => {
      const cp = mesh.userData.controlPoints;
      if (!cp || cp.length !== 3) return;
      const from = Number(mesh.userData.fromOffset ?? mesh.userData.offset ?? 0);
      const to = Number(mesh.userData.toOffset ?? mesh.userData.offset ?? 0);
      const t = Math.min(0.99, Math.max(0.01, from + (to - from) * alpha));
      const pos = computeCurvePoint(cp, t);
      const tan = computeCurveTangent(cp, t);
      mesh.position.copy(pos);
      mesh.position.y += 1.1;
      mesh.rotation.y = Math.atan2(tan.x, tan.z);
    });
  }

  /**
   * Animate precipitation particle system.
   * Used by: initScene() render loop each animation frame.
   */
  function animateWeather() {
    const time = performance.now() * 0.0012;
    state.weatherParticles.forEach((p, i) => {
      p.position.y -= p.userData.speed;
      p.position.x += Math.sin(time + i) * 0.01;
      p.position.z += Math.cos(time * 0.7 + i) * 0.01;
      if (p.position.y < 0) p.position.y = 62 + (i % 10);
    });
  }

  return { state, updateScene, sceneStateEl, vehicleCountEl };
}

/**
 * Apply snapshot state into 3D scene groups and return graph counters.
 * Used by: frontend/src/main.ts applyState() after REST/WS updates.
 */
export function updateScene(
  graphData: any,
  residents: any[],
  activeEvents: any[],
  weather: string,
  buildingsByNode: Map<string, string>,
) {
  if (!graphData?.nodes?.length) {
    state.cityGroup.clear();
    state.roadsGroup.clear();
    state.alertsGroup.clear();
    state.vehiclesGroup.clear();
    state.atmosphereGroup.clear();
    state.vehicleMeshes = [];
    state.roadMeshesById.clear();
    state.vehicleMeshesByKey.clear();
    state.weatherParticles = [];
    state.staticGraphSignature = null;
    return;
  }

  const nodes = projectGraph(graphData.nodes);
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));
  const edges = graphData.edges || [];
  const edgeById = new Map(edges.map((e: any) => [e.edge_id, e]));

  const residentsByNode = new Map<string, number>();
  residents.forEach((r: any) => {
    residentsByNode.set(r.current_node_id, (residentsByNode.get(r.current_node_id) || 0) + 1);
  });

  const sig = `${nodes.map((n) => n.node_id).join(",")}::${edges.map((e: any) => e.edge_id).join(",")}`;
  if (state.staticGraphSignature !== sig) {
    state.cityGroup.clear();
    state.buildingsByNode = buildingsByNode;
    addBuildings(nodes, buildingsByNode);
    addParks(nodes);
    addHubs(nodes, residentsByNode);
    state.staticGraphSignature = sig;
  }

  upsertRoads(edges, nodeById);
  updateAlerts(activeEvents || [], nodeById, edgeById);
  addVehicles(residents, edges, edgeById, nodeById, state.vehicleMeshesByKey.get as any);
  applyWeather(weather, state.scene as any);

  return { nodeCount: nodes.length, edgeCount: edges.length, blockedCount: edges.filter((e: any) => e.blocked).length };
}
