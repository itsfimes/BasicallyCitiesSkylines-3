import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const API = "http://localhost:8000";

const WEATHER_PRESETS = {
  clear: {
    background: 0xcdd3c8,
    fog: 0xcdd3c8,
    sun: 1.45,
    ambient: 1.35,
    sceneLabel: "Dry daylight",
  },
  rain: {
    background: 0xaeb8bb,
    fog: 0xaeb8bb,
    sun: 0.8,
    ambient: 1,
    sceneLabel: "Rain front",
  },
  storm: {
    background: 0x8e9698,
    fog: 0x8e9698,
    sun: 0.58,
    ambient: 0.84,
    sceneLabel: "Storm cell",
  },
  snow: {
    background: 0xdfe4e3,
    fog: 0xdfe4e3,
    sun: 1,
    ambient: 1.42,
    sceneLabel: "Snow cover",
  },
  heatwave: {
    background: 0xd6c6a8,
    fog: 0xd6c6a8,
    sun: 1.62,
    ambient: 1.2,
    sceneLabel: "Heat haze",
  },
};

const EVENT_PAYLOAD_CONFIG = {
  accident: {
    key: "edge_id",
    required: true,
    placeholder: "e12",
    hint: "Accident events require an `edge_id` payload.",
  },
  road_closure: {
    key: "edge_id",
    required: true,
    placeholder: "e07",
    hint: "Road closures require an `edge_id` payload so the backend can block the route.",
  },
  concert: {
    key: "node_id",
    required: true,
    placeholder: "n3",
    hint: "Concerts must target a destination node via `node_id`.",
  },
  extreme_weather: {
    key: "weather",
    required: true,
    placeholder: "rain",
    hint: "Extreme weather events require a `weather` payload such as rain or snow.",
  },
  outage: {
    key: "district",
    required: false,
    placeholder: "west-grid",
    hint: "Outages can include an optional district or infrastructure tag.",
  },
};

const trafficDensityEl = document.getElementById("trafficDensity");
const avgDelayEl = document.getElementById("avgDelay");
const emissionsEl = document.getElementById("emissions");
const energyEl = document.getElementById("energy");
const mapEl = document.getElementById("map");
const simTimeEl = document.getElementById("simTime");
const weatherStateEl = document.getElementById("weatherState");
const eventCountEl = document.getElementById("eventCount");
const residentCountEl = document.getElementById("residentCount");
const movingCountEl = document.getElementById("movingCount");
const delayedCountEl = document.getElementById("delayedCount");
const nodeCountEl = document.getElementById("nodeCount");
const edgeCountEl = document.getElementById("edgeCount");
const blockedCountEl = document.getElementById("blockedCount");
const vehicleCountEl = document.getElementById("vehicleCount");
const networkMoodEl = document.getElementById("networkMood");
const sceneStateEl = document.getElementById("sceneState");
const statusMessageEl = document.getElementById("statusMessage");
const activeEventsEl = document.getElementById("activeEvents");
const eventCountBadgeEl = document.getElementById("eventCountBadge");
const eventFormEl = document.getElementById("eventForm");
const eventTypeEl = eventFormEl.querySelector('[name="event_type"]');
const payloadTargetEl = eventFormEl.querySelector('[name="payload_target"]');
const eventHintEl = document.getElementById("eventHint");

const sceneState = createCityScene(mapEl);

document.getElementById("step1").addEventListener("click", () => step(1));
document.getElementById("step10").addEventListener("click", () => step(10));
document.getElementById("run60").addEventListener("click", () => step(60));
document.getElementById("reset").addEventListener("click", resetSimulation);
eventTypeEl.addEventListener("change", updateEventHints);

eventFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const eventType = String(form.get("event_type"));
  const config = EVENT_PAYLOAD_CONFIG[eventType] || EVENT_PAYLOAD_CONFIG.outage;
  const payloadTarget = String(form.get("payload_target") || "").trim();
  const payload = {};

  if (config.required && !payloadTarget) {
    setStatus(`${config.key} is required for ${eventType}.`, "error");
    payloadTargetEl.reportValidity();
    payloadTargetEl.focus();
    return;
  }

  if (payloadTarget) {
    payload[config.key] = payloadTarget;
  }

  try {
    await requestJson(
      "/api/event",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: String(form.get("event_id")),
          event_type: eventType,
          duration_minutes: Number(form.get("duration_minutes")),
          payload,
        }),
      },
      "Injecting disruption...",
    );
    event.currentTarget.reset();
    updateEventHints();
    await refresh("Scenario injected.");
  } catch {}
});

function createCityScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcdd3c8);
  scene.fog = new THREE.Fog(0xcdd3c8, 190, 330);

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

  const ambientLight = new THREE.HemisphereLight(0xf7f4ec, 0x879281, 1.35);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xfffcf4, 1.45);
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
    new THREE.MeshStandardMaterial({ color: 0xa7b09f, roughness: 1, metalness: 0 }),
  );
  ground.receiveShadow = true;
  ground.position.y = -3.6;
  scene.add(ground);

  const plaza = new THREE.Mesh(
    new THREE.CylinderGeometry(78, 84, 0.7, 8),
    new THREE.MeshStandardMaterial({ color: 0xdcd8c9, roughness: 0.95, metalness: 0 }),
  );
  plaza.receiveShadow = true;
  scene.add(plaza);

  const baseRing = new THREE.Mesh(
    new THREE.TorusGeometry(66, 1.25, 18, 100),
    new THREE.MeshStandardMaterial({ color: 0xc2bca9, roughness: 0.9 }),
  );
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = 0.4;
  scene.add(baseRing);

  const waterRing = new THREE.Mesh(
    new THREE.TorusGeometry(84, 8, 18, 100),
    new THREE.MeshStandardMaterial({ color: 0xaec8c9, roughness: 0.78, metalness: 0.03 }),
  );
  waterRing.rotation.x = Math.PI / 2;
  waterRing.position.y = -2.2;
  scene.add(waterRing);

  const cityGroup = new THREE.Group();
  scene.add(cityGroup);

  const atmosphereGroup = new THREE.Group();
  scene.add(atmosphereGroup);

  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const nodeGeometry = new THREE.CylinderGeometry(1.65, 1.65, 3.5, 18);
  const roadGeometry = new THREE.BoxGeometry(1, 0.9, 1);
  const vehicleGeometry = new THREE.BoxGeometry(1.2, 0.8, 2.6);
  const treeGeometry = new THREE.ConeGeometry(1.4, 4.4, 8);
  const treeTrunkGeometry = new THREE.CylinderGeometry(0.22, 0.28, 1.2, 8);
  const alertGeometry = new THREE.CylinderGeometry(0.35, 0.35, 10, 10);

  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    animateVehicles();
    animateWeather();
    renderer.render(scene, camera);
  });

  function animateVehicles() {
    const time = performance.now() * 0.00035;
    sceneState.vehicleMeshes.forEach((vehicle, index) => {
      const route = vehicle.userData.route;
      if (!route) {
        return;
      }
      const t = (time * vehicle.userData.speed + vehicle.userData.offset) % 1;
      const position = route.getPointAt(t);
      const tangent = route.getTangentAt(t).normalize();
      vehicle.position.copy(position);
      vehicle.position.y += 1.1;
      vehicle.rotation.y = Math.atan2(tangent.x, tangent.z);
    });
  }

  function animateWeather() {
    const time = performance.now() * 0.0012;
    sceneState.weatherParticles.forEach((particle, index) => {
      particle.position.y -= particle.userData.speed;
      particle.position.x += Math.sin(time + index) * 0.01;
      particle.position.z += Math.cos(time * 0.7 + index) * 0.01;
      if (particle.position.y < 0) {
        particle.position.y = 62 + (index % 10);
      }
    });
  }

  return {
    scene,
    camera,
    cityGroup,
    atmosphereGroup,
    buildingGeometry,
    nodeGeometry,
    roadGeometry,
    vehicleGeometry,
    treeGeometry,
    treeTrunkGeometry,
    alertGeometry,
    renderer,
    resizeObserver,
    controls,
    ambientLight,
    sunLight,
    ground,
    plaza,
    vehicleMeshes: [],
    weatherParticles: [],
  };
}

function setStatus(message, state = "idle") {
  statusMessageEl.textContent = message;
  statusMessageEl.dataset.state = state;
}

async function requestJson(path, options = {}, pendingMessage = "Syncing control room...") {
  setStatus(pendingMessage, "busy");
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage = data.error || `Request failed with status ${response.status}.`;
    setStatus(errorMessage, "error");
    throw new Error(errorMessage);
  }
  return data;
}

async function resetSimulation() {
  try {
    await requestJson(
      "/api/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: 42, resident_count: 2500 }),
      },
      "Resetting simulation...",
    );
    await refresh("Simulation reset to baseline.");
  } catch {}
}

async function step(count) {
  try {
    const data = await requestJson(
      "/api/step",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count }),
      },
      `Advancing simulation by ${count} minute${count === 1 ? "" : "s"}...`,
    );
    applyState(data.state);
    setStatus(`Simulation advanced by ${count} minute${count === 1 ? "" : "s"}.`, "ok");
  } catch {}
}

function formatNumber(value, maximumFractionDigits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "-";
  }
  return numericValue.toLocaleString(undefined, {
    maximumFractionDigits,
  });
}

function formatMinute(minute) {
  const totalMinutes = Math.max(0, Number(minute) || 0);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function titleCase(value) {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMetrics(metric) {
  if (!metric) {
    return;
  }
  trafficDensityEl.textContent = formatNumber(metric.traffic_density);
  avgDelayEl.textContent = formatNumber(metric.avg_delay_minutes);
  emissionsEl.textContent = formatNumber(metric.emissions_kg_co2);
  energyEl.textContent = formatNumber(metric.energy_kwh);
}

function describeNetworkMood(state) {
  const blocked = state.graph?.edges?.filter((edge) => edge.blocked).length || 0;
  const density = Number(state.last_metrics?.traffic_density || 0);
  const activeEvents = state.active_events?.length || 0;

  if (blocked > 0) {
    return "Network under disruption";
  }
  if (activeEvents > 0 || density > 25) {
    return "Pressure building";
  }
  if (density > 12) {
    return "Dense commuter flow";
  }
  return "Steady flow";
}

function renderOverview(state) {
  const residents = state.residents || [];
  const movingResidents = residents.filter((resident) => resident.moving_edge_id).length;
  const delayedResidents = residents.filter((resident) => Number(resident.delayed_minutes) > 0).length;

  simTimeEl.textContent = formatMinute(state.minute);
  weatherStateEl.textContent = titleCase(state.weather);
  eventCountEl.textContent = formatNumber(state.active_events?.length || 0, 0);
  residentCountEl.textContent = formatNumber(residents.length, 0);
  movingCountEl.textContent = formatNumber(movingResidents, 0);
  delayedCountEl.textContent = formatNumber(delayedResidents, 0);
  networkMoodEl.textContent = describeNetworkMood(state);
  renderActiveEvents(state.active_events || []);
}

function renderActiveEvents(events) {
  eventCountBadgeEl.textContent = `${events.length} live`;
  if (!events.length) {
    activeEventsEl.innerHTML = '<p class="event-empty">No active disruptions.</p>';
    return;
  }

  activeEventsEl.innerHTML = events
    .map((event) => {
      const payloadEntries = Object.entries(event.payload || {});
      const payload = payloadEntries.length
        ? payloadEntries
            .map(([key, value]) => `<code>${escapeHtml(key)}</code>: ${escapeHtml(value)}`)
            .join("<br />")
        : "No payload context.";

      return `
        <article class="event-chip">
          <small>${escapeHtml(titleCase(event.event_type))}</small>
          <strong>${escapeHtml(event.event_id)}</strong>
          <small>Duration: ${escapeHtml(event.duration_minutes)} min</small>
          <small>${payload}</small>
        </article>
      `;
    })
    .join("");
}

function projectGraph(nodes) {
  const xValues = nodes.map((node) => node.x);
  const yValues = nodes.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return nodes.map((node) => {
    const x = ((node.x - minX) / (maxX - minX || 1) - 0.5) * 100;
    const z = ((node.y - minY) / (maxY - minY || 1) - 0.5) * 100;
    return {
      ...node,
      sceneX: x,
      sceneZ: z,
    };
  });
}

function clearGroup(group) {
  group.clear();
}

function roadMaterial(edge) {
  if (edge.blocked) {
    return new THREE.MeshStandardMaterial({ color: 0x9f4f41, roughness: 0.74 });
  }
  if (edge.congestion > 20) {
    return new THREE.MeshStandardMaterial({ color: 0xcb8b39, roughness: 0.72 });
  }
  return new THREE.MeshStandardMaterial({ color: 0x4f5952, roughness: 0.82, metalness: 0.04 });
}

function addBuildings(nodes) {
  const palette = [0xd7d1bf, 0xc4bda9, 0xb7c1b0, 0xadb8aa, 0xd6cfbf, 0xb8c5bd];
  nodes.forEach((node, index) => {
    const ringCount = 4 + (index % 3);
    for (let offsetIndex = 0; offsetIndex < ringCount; offsetIndex += 1) {
      const angle = (Math.PI * 2 * offsetIndex) / ringCount + index * 0.22;
      const radius = 7 + ((index + offsetIndex) % 4) * 2.1;
      const width = 3 + ((index + offsetIndex) % 3) * 1.4;
      const depth = 2.8 + ((index + offsetIndex) % 2) * 1.2;
      const height = 4 + ((index * 5 + offsetIndex * 7) % 20);
      const building = new THREE.Mesh(
        sceneState.buildingGeometry,
        new THREE.MeshStandardMaterial({
          color: palette[(index + offsetIndex) % palette.length],
          roughness: 0.96,
          metalness: 0.02,
        }),
      );
      building.castShadow = true;
      building.receiveShadow = true;
      building.scale.set(width, height, depth);
      building.position.set(node.sceneX + Math.cos(angle) * radius, height / 2, node.sceneZ + Math.sin(angle) * radius);
      building.rotation.y = angle * 0.72;
      sceneState.cityGroup.add(building);
    }
  });
}

function addParks(nodes) {
  nodes.forEach((node, index) => {
    if (index % 2 !== 0) {
      return;
    }
    const park = new THREE.Mesh(
      new THREE.CylinderGeometry(4.4, 5.4, 0.3, 6),
      new THREE.MeshStandardMaterial({ color: 0x90ab89, roughness: 1 }),
    );
    park.receiveShadow = true;
    park.position.set(node.sceneX - 5.5, 0.16, node.sceneZ + 5.2);
    sceneState.cityGroup.add(park);

    for (let treeIndex = 0; treeIndex < 3; treeIndex += 1) {
      const angle = (Math.PI * 2 * treeIndex) / 3 + index * 0.4;
      const trunk = new THREE.Mesh(
        sceneState.treeTrunkGeometry,
        new THREE.MeshStandardMaterial({ color: 0x7c6752, roughness: 1 }),
      );
      trunk.castShadow = true;
      trunk.position.set(park.position.x + Math.cos(angle) * 1.6, 0.75, park.position.z + Math.sin(angle) * 1.5);
      sceneState.cityGroup.add(trunk);

      const crown = new THREE.Mesh(
        sceneState.treeGeometry,
        new THREE.MeshStandardMaterial({ color: 0x66835b, roughness: 1 }),
      );
      crown.castShadow = true;
      crown.position.set(trunk.position.x, 3.2, trunk.position.z);
      sceneState.cityGroup.add(crown);
    }
  });
}

function addRoads(edges, nodeById) {
  edges.forEach((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      return;
    }

    const dx = target.sceneX - source.sceneX;
    const dz = target.sceneZ - source.sceneZ;
    const length = Math.hypot(dx, dz);
    const width = Math.min(5.8, 1.8 + edge.congestion / 10);
    const road = new THREE.Mesh(sceneState.roadGeometry, roadMaterial(edge));
    road.castShadow = true;
    road.receiveShadow = true;
    road.scale.set(width, 1, length);
    road.position.set((source.sceneX + target.sceneX) / 2, 0.45, (source.sceneZ + target.sceneZ) / 2);
    road.rotation.y = Math.atan2(dx, dz);
    sceneState.cityGroup.add(road);
  });
}

function addHubs(nodes, residentsByNode) {
  nodes.forEach((node, index) => {
    const residentLoad = residentsByNode.get(node.node_id) || 0;
    const towerHeight = 5 + (index % 4) * 1.2 + Math.min(8, residentLoad / 35);
    const tower = new THREE.Mesh(
      sceneState.nodeGeometry,
      new THREE.MeshStandardMaterial({
        color: residentLoad > 120 ? 0x2b5946 : 0x6d8a78,
        roughness: 0.58,
        metalness: 0.12,
      }),
    );
    tower.castShadow = true;
    tower.receiveShadow = true;
    tower.scale.y = towerHeight / 3.5;
    tower.position.set(node.sceneX, towerHeight / 2 + 0.4, node.sceneZ);
    sceneState.cityGroup.add(tower);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 1.6, 14),
      new THREE.MeshStandardMaterial({ color: 0xf2efe2, roughness: 0.35, metalness: 0.18 }),
    );
    cap.castShadow = true;
    cap.position.set(node.sceneX, towerHeight + 1, node.sceneZ);
    sceneState.cityGroup.add(cap);
  });
}

function addAlerts(events, nodeById, edgeById) {
  events.forEach((event, index) => {
    const alert = new THREE.Mesh(
      sceneState.alertGeometry,
      new THREE.MeshStandardMaterial({ color: 0x9f4f41, emissive: 0x4d1f19, roughness: 0.35, metalness: 0.08 }),
    );
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
      const node = nodeById.get(nodeId);
      x = node.sceneX;
      z = node.sceneZ;
    }

    alert.position.set(x, 5.5, z);
    sceneState.cityGroup.add(alert);
  });
}

function addVehicles(residents, edgeById, nodeById) {
  sceneState.vehicleMeshes = [];
  const movingResidents = residents.filter((resident) => resident.moving_edge_id && edgeById.has(resident.moving_edge_id)).slice(0, 220);
  vehicleCountEl.textContent = formatNumber(movingResidents.length, 0);

  movingResidents.forEach((resident, index) => {
    const edge = edgeById.get(resident.moving_edge_id);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      return;
    }

    const route = new THREE.CatmullRomCurve3([
      new THREE.Vector3(source.sceneX, 0.6, source.sceneZ),
      new THREE.Vector3((source.sceneX + target.sceneX) / 2, 0.85, (source.sceneZ + target.sceneZ) / 2),
      new THREE.Vector3(target.sceneX, 0.6, target.sceneZ),
    ]);

    const modeColor = resident.mode === "car" ? 0x3b4650 : resident.mode === "public_transport" ? 0x29654f : 0xc48e47;
    const vehicle = new THREE.Mesh(
      sceneState.vehicleGeometry,
      new THREE.MeshStandardMaterial({ color: modeColor, roughness: 0.5, metalness: 0.12 }),
    );
    vehicle.castShadow = true;
    vehicle.receiveShadow = true;
    vehicle.userData = {
      route,
      speed: 0.08 + (index % 5) * 0.012,
      offset: (index * 0.071) % 1,
    };
    sceneState.cityGroup.add(vehicle);
    sceneState.vehicleMeshes.push(vehicle);
  });
}

function applyWeather(weather) {
  const preset = WEATHER_PRESETS[String(weather).toLowerCase()] || WEATHER_PRESETS.clear;
  sceneState.scene.background.setHex(preset.background);
  sceneState.scene.fog.color.setHex(preset.fog);
  sceneState.ambientLight.intensity = preset.ambient;
  sceneState.sunLight.intensity = preset.sun;
  sceneStateEl.textContent = preset.sceneLabel;

  clearGroup(sceneState.atmosphereGroup);
  sceneState.weatherParticles = [];

  if (preset === WEATHER_PRESETS.clear) {
    return;
  }

  const particleCount = preset === WEATHER_PRESETS.snow ? 180 : 140;
  const materialColor = preset === WEATHER_PRESETS.snow ? 0xf6f7f6 : 0x88a1a6;

  for (let index = 0; index < particleCount; index += 1) {
    const particle = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, preset === WEATHER_PRESETS.snow ? 0.15 : 1.4, 0.15),
      new THREE.MeshStandardMaterial({ color: materialColor, roughness: 0.45, transparent: true, opacity: 0.55 }),
    );
    particle.position.set((index % 18) * 7 - 62, 12 + (index % 16) * 3.1, Math.floor(index / 18) * 8 - 36);
    particle.userData.speed = preset === WEATHER_PRESETS.snow ? 0.08 + (index % 4) * 0.015 : 0.3 + (index % 5) * 0.03;
    sceneState.atmosphereGroup.add(particle);
    sceneState.weatherParticles.push(particle);
  }
}

function renderMap(state) {
  const graph = state.graph;
  if (!graph || !graph.nodes?.length) {
    nodeCountEl.textContent = "0";
    edgeCountEl.textContent = "0";
    blockedCountEl.textContent = "0";
    vehicleCountEl.textContent = "0";
    clearGroup(sceneState.cityGroup);
    return;
  }

  const projectedNodes = projectGraph(graph.nodes);
  const nodeById = new Map(projectedNodes.map((node) => [node.node_id, node]));
  const edgeById = new Map((graph.edges || []).map((edge) => [edge.edge_id, edge]));
  const residents = state.residents || [];
  const residentsByNode = new Map();

  residents.forEach((resident) => {
    const count = residentsByNode.get(resident.current_node_id) || 0;
    residentsByNode.set(resident.current_node_id, count + 1);
  });

  const edges = graph.edges || [];
  const blockedCount = edges.filter((edge) => edge.blocked).length;

  nodeCountEl.textContent = formatNumber(projectedNodes.length, 0);
  edgeCountEl.textContent = formatNumber(edges.length, 0);
  blockedCountEl.textContent = formatNumber(blockedCount, 0);

  clearGroup(sceneState.cityGroup);
  addBuildings(projectedNodes);
  addParks(projectedNodes);
  addRoads(edges, nodeById);
  addHubs(projectedNodes, residentsByNode);
  addAlerts(state.active_events || [], nodeById, edgeById);
  addVehicles(residents, edgeById, nodeById);
  applyWeather(state.weather);
}

function applyState(state) {
  renderOverview(state);
  if (state.last_metrics) {
    renderMetrics(state.last_metrics);
  }
  renderMap(state);
}

function updateEventHints() {
  const config = EVENT_PAYLOAD_CONFIG[eventTypeEl.value] || EVENT_PAYLOAD_CONFIG.outage;
  payloadTargetEl.placeholder = config.placeholder;
  payloadTargetEl.required = config.required;
  payloadTargetEl.setAttribute("aria-label", config.key);
  eventHintEl.innerHTML = config.hint.replaceAll(/`([^`]+)`/g, "<code>$1</code>");
}

async function refresh(successMessage = "Live data synchronized.") {
  try {
    const data = await requestJson("/api/state", {}, "Fetching live simulation state...");
    applyState(data.state);
    setStatus(successMessage, "ok");
  } catch {}
}

updateEventHints();
refresh();
