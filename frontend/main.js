import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const API = "http://localhost:8000";

const EVENT_TYPE_LABELS = {
  accident: "Road accident",
  road_closure: "Road closure",
  concert: "Concert surge",
  extreme_weather: "Extreme weather",
  outage: "Infrastructure outage",
};

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
    hint: "Select the edge where the road accident occurs.",
    targetLabel: "Edge",
    fallback: "No edges available.",
    source: "edges",
  },
  road_closure: {
    key: "edge_id",
    required: true,
    hint: "Select the edge to close.",
    targetLabel: "Edge",
    fallback: "No edges available.",
    source: "edges",
  },
  concert: {
    key: "node_id",
    required: true,
    hint: "Select the node where the concert surge should happen.",
    targetLabel: "Node",
    fallback: "No nodes available.",
    source: "nodes",
  },
  extreme_weather: {
    key: "weather",
    required: true,
    hint: "Select the weather condition to apply.",
    targetLabel: "Weather",
    fallback: "No weather options available.",
    source: "weather",
  },
  outage: {
    key: "district",
    required: false,
    hint: "No target is required for outages.",
    targetLabel: "Scope",
    fallback: "No target needed.",
    source: "none",
  },
};

const WEATHER_OPTIONS = ["rain", "storm", "snow"];

const incidentState = {
  nodes: [],
  edges: [],
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
const liveToggleEl = document.getElementById("liveToggle");
const liveSpeedEl = document.getElementById("liveSpeed");

const LIVE_BASE_TICK_MS = 1000;
const STATE_POLL_MS = 250;

const liveState = {
  running: false,
  pollTimerId: null,
  polling: false,
};

const interpolationState = {
  previousTimeSeconds: null,
  currentTimeSeconds: null,
  previousAtMs: null,
  currentAtMs: null,
};

let activeRunId = 0;
let lastAppliedTimeSeconds = -1;

const sceneState = createCityScene(mapEl);

document.getElementById("reset").addEventListener("click", resetSimulation);
eventTypeEl.addEventListener("change", updateEventHints);
liveToggleEl.addEventListener("click", toggleLiveMode);
liveSpeedEl.addEventListener("change", syncRuntimeControls);

eventFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const eventType = String(form.get("event_type"));
  const config = EVENT_PAYLOAD_CONFIG[eventType] || EVENT_PAYLOAD_CONFIG.outage;
  const payloadTarget = String(form.get("payload_target") || "").trim();
  const eventId = buildEventId(eventType, payloadTarget);
  const payload = {};
  const eventLabel = EVENT_TYPE_LABELS[eventType] || titleCase(eventType);

  if (config.required && !payloadTarget) {
    setStatus(`Please select a ${config.targetLabel.toLowerCase()} for ${eventLabel}.`, "error");
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
          event_id: eventId,
          event_type: eventType,
          duration_minutes: Number(form.get("duration_minutes")),
          payload,
        }),
      },
      "Submitting incident...",
    );
    event.currentTarget.reset();
    updateEventHints();
    await refresh("Incident injected.");
  } catch {}
});

function getTargetOptions(config) {
  if (config.source === "nodes") {
    return incidentState.nodes;
  }
  if (config.source === "edges") {
    return incidentState.edges;
  }
  if (config.source === "weather") {
    return WEATHER_OPTIONS;
  }
  if (config.source === "none") {
    return [];
  }
  return [];
}

function populateTargetSelect(config) {
  const options = getTargetOptions(config);
  payloadTargetEl.innerHTML = "";

  if (config.source === "none") {
    payloadTargetEl.innerHTML = '<option value="">No target needed</option>';
    payloadTargetEl.disabled = true;
    payloadTargetEl.required = false;
    return;
  }

  if (!options.length) {
    payloadTargetEl.innerHTML = `<option value="">${escapeHtml(config.fallback)}</option>`;
    payloadTargetEl.disabled = true;
    payloadTargetEl.required = false;
    return;
  }

  payloadTargetEl.disabled = false;
  payloadTargetEl.required = config.required;
  payloadTargetEl.innerHTML = options
    .map((value) => `<option value="${escapeHtml(String(value))}">${escapeHtml(String(value))}</option>`)
    .join("");
}

function buildEventId(eventType, payloadTarget) {
  const safeTarget = String(payloadTarget || "target")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${eventType}-${safeTarget || "target"}-${Date.now()}`;
}

function getLiveTickIntervalMs() {
  const speedMultiplier = Number(liveSpeedEl.value || 1);
  const safeSpeed = Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
  return Math.max(80, Math.round(LIVE_BASE_TICK_MS / safeSpeed));
}

function markSnapshotArrival(simTimeSeconds) {
  const now = performance.now();
  if (Number.isFinite(interpolationState.currentTimeSeconds)) {
    interpolationState.previousTimeSeconds = interpolationState.currentTimeSeconds;
    interpolationState.previousAtMs = interpolationState.currentAtMs;
  }
  interpolationState.currentTimeSeconds = simTimeSeconds;
  interpolationState.currentAtMs = now;

  if (
    !Number.isFinite(interpolationState.previousTimeSeconds) ||
    simTimeSeconds < interpolationState.previousTimeSeconds
  ) {
    interpolationState.previousTimeSeconds = simTimeSeconds;
    interpolationState.previousAtMs = now;
  }
}

function getInterpolationAlpha() {
  if (
    !Number.isFinite(interpolationState.previousTimeSeconds) ||
    !Number.isFinite(interpolationState.currentTimeSeconds)
  ) {
    return 1;
  }

  const simTimeDeltaSeconds = interpolationState.currentTimeSeconds - interpolationState.previousTimeSeconds;
  if (simTimeDeltaSeconds <= 0) {
    return 1;
  }

  const previousAtMs = Number(interpolationState.previousAtMs || interpolationState.currentAtMs || performance.now());
  const currentAtMs = Number(interpolationState.currentAtMs || previousAtMs);
  const speedMultiplier = Number(liveSpeedEl.value || 1);
  const safeSpeed = Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
  const expectedIntervalMs = Math.max(80, Math.round(LIVE_BASE_TICK_MS / safeSpeed));
  const expectedForSimDeltaMs = expectedIntervalMs * simTimeDeltaSeconds;
  const arrivalDeltaMs = Math.max(expectedForSimDeltaMs, currentAtMs - previousAtMs);
  const elapsedSinceCurrentMs = Math.max(0, performance.now() - currentAtMs);
  return Math.min(1, elapsedSinceCurrentMs / arrivalDeltaMs);
}

function setLiveUiState() {
  liveToggleEl.textContent = liveState.running ? "Pause Live" : "Resume Live";
}

async function syncRuntimeControls() {
  const targetRunning = liveState.running;
  try {
    const payload = {
      running: targetRunning,
      speed_multiplier: Number(liveSpeedEl.value || 1),
    };
    const data = await requestJson(
      "/api/runtime",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      null,
    );
    const runtime = data.runtime || {};
    liveState.running = Boolean(runtime.running);
    setLiveUiState();
    setStatus(`Live mode ${liveState.running ? "running" : "paused"} at ${liveSpeedEl.value}x.`, "ok");
    return true;
  } catch {
    liveState.running = !targetRunning;
    setLiveUiState();
    setStatus("Failed to update live controls. State restored.", "error");
    await initializeRuntime();
    return false;
  }
}

function scheduleStatePolling(delayMs = STATE_POLL_MS) {
  if (liveState.pollTimerId !== null) {
    clearTimeout(liveState.pollTimerId);
  }
  liveState.pollTimerId = setTimeout(pollLiveState, Math.max(80, delayMs));
}

async function pollLiveState() {
  if (liveState.polling) {
    scheduleStatePolling(STATE_POLL_MS);
    return;
  }

  liveState.polling = true;
  try {
    await refresh(null);
  } finally {
    liveState.polling = false;
    scheduleStatePolling(liveState.running ? STATE_POLL_MS : Math.max(STATE_POLL_MS, getLiveTickIntervalMs()));
  }
}

async function toggleLiveMode() {
  liveState.running = !liveState.running;
  setLiveUiState();
  await syncRuntimeControls();
}

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

  const flowGroup = new THREE.Group();
  scene.add(flowGroup);

  const roadsGroup = new THREE.Group();
  flowGroup.add(roadsGroup);

  const alertsGroup = new THREE.Group();
  flowGroup.add(alertsGroup);

  const vehiclesGroup = new THREE.Group();
  flowGroup.add(vehiclesGroup);

  const atmosphereGroup = new THREE.Group();
  scene.add(atmosphereGroup);

  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const nodeGeometry = new THREE.CylinderGeometry(1.65, 1.65, 3.5, 18);
  const roadGeometry = new THREE.BoxGeometry(1, 0.9, 1);
  const vehicleGeometry = new THREE.BoxGeometry(1.2, 0.8, 2.6);
  const treeGeometry = new THREE.ConeGeometry(1.4, 4.4, 8);
  const treeTrunkGeometry = new THREE.CylinderGeometry(0.22, 0.28, 1.2, 8);
  const alertGeometry = new THREE.CylinderGeometry(0.35, 0.35, 10, 10);
  const weatherParticleGeometry = new THREE.BoxGeometry(0.15, 1, 0.15);

  const roadMaterials = {
    blocked: new THREE.MeshStandardMaterial({ color: 0x9f4f41, roughness: 0.74 }),
    congested: new THREE.MeshStandardMaterial({ color: 0xcb8b39, roughness: 0.72 }),
    stable: new THREE.MeshStandardMaterial({ color: 0x4f5952, roughness: 0.82, metalness: 0.04 }),
  };

  const vehicleMaterials = {
    car: new THREE.MeshStandardMaterial({ color: 0x3b4650, roughness: 0.5, metalness: 0.12 }),
    public_transport: new THREE.MeshStandardMaterial({ color: 0x29654f, roughness: 0.5, metalness: 0.12 }),
    other: new THREE.MeshStandardMaterial({ color: 0xc48e47, roughness: 0.5, metalness: 0.12 }),
  };

  const alertMaterial = new THREE.MeshStandardMaterial({
    color: 0x9f4f41,
    emissive: 0x4d1f19,
    roughness: 0.35,
    metalness: 0.08,
  });

  const weatherMaterials = {
    rain: new THREE.MeshStandardMaterial({ color: 0x88a1a6, roughness: 0.45, transparent: true, opacity: 0.55 }),
    snow: new THREE.MeshStandardMaterial({ color: 0xf6f7f6, roughness: 0.45, transparent: true, opacity: 0.55 }),
  };

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
    const alpha = getInterpolationAlpha();
    sceneState.vehicleMeshes.forEach((vehicle) => {
      const controlPoints = vehicle.userData.controlPoints;
      if (!controlPoints || controlPoints.length !== 3) {
        return;
      }
      const fromOffset = Number(vehicle.userData.fromOffset ?? vehicle.userData.offset ?? 0);
      const toOffset = Number(vehicle.userData.toOffset ?? vehicle.userData.offset ?? 0);
      const t = Math.min(0.99, Math.max(0.01, fromOffset + (toOffset - fromOffset) * alpha));
      const position = computeCurvePoint(controlPoints, t);
      const tangent = computeCurveTangent(controlPoints, t);
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
    flowGroup,
    roadsGroup,
    alertsGroup,
    vehiclesGroup,
    atmosphereGroup,
    buildingGeometry,
    nodeGeometry,
    roadGeometry,
    vehicleGeometry,
    treeGeometry,
    treeTrunkGeometry,
    alertGeometry,
    weatherParticleGeometry,
    roadMaterials,
    vehicleMaterials,
    alertMaterial,
    weatherMaterials,
    renderer,
    resizeObserver,
    controls,
    ambientLight,
    sunLight,
    ground,
    plaza,
    vehicleMeshes: [],
    roadMeshesById: new Map(),
    vehicleMeshesByKey: new Map(),
    weatherParticles: [],
    staticGraphSignature: null,
    currentWeatherKey: null,
  };
}

function setStatus(message, state = "idle") {
  statusMessageEl.textContent = message;
  statusMessageEl.dataset.state = state;
}

async function requestJson(path, options = {}, pendingMessage = "Syncing control room...") {
  if (pendingMessage !== null) {
    setStatus(pendingMessage, "busy");
  }
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
  activeRunId += 1;
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
    lastAppliedTimeSeconds = -1;
    interpolationState.previousTimeSeconds = null;
    interpolationState.currentTimeSeconds = null;
    interpolationState.previousAtMs = null;
    interpolationState.currentAtMs = null;
    await refresh("Simulation reset to baseline.");
    await syncRuntimeControls();
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
  const totalSeconds = Math.max(0, Math.round(Number(minute) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `T+${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
    return "Network disrupted";
  }
  if (activeEvents > 0 || density > 25) {
    return "Increasing congestion";
  }
  if (density > 12) {
    return "Heavy commuter traffic";
  }
  return "Steady traffic flow";
}

function renderOverview(state) {
  const residents = state.residents || [];
  const movingResidents = residents.filter((resident) => resident.moving_edge_id).length;
  const delayedResidents = residents.filter((resident) => Number(resident.delayed_minutes) > 0).length;

  simTimeEl.textContent = formatMinute(state.sim_time_seconds);
  weatherStateEl.textContent = titleCase(state.weather);
  eventCountEl.textContent = formatNumber(state.active_events?.length || 0, 0);
  residentCountEl.textContent = formatNumber(residents.length, 0);
  movingCountEl.textContent = formatNumber(movingResidents, 0);
  delayedCountEl.textContent = formatNumber(delayedResidents, 0);
  networkMoodEl.textContent = describeNetworkMood(state);
  renderActiveEvents(state.active_events || []);

  incidentState.nodes = (state.graph?.nodes || []).map((node) => node.node_id);
  incidentState.edges = (state.graph?.edges || []).map((edge) => edge.edge_id);
  updateEventHints();
}

function renderActiveEvents(events) {
  eventCountBadgeEl.textContent = `${events.length} live`;
  if (!events.length) {
    activeEventsEl.innerHTML = '<p class="event-empty">No active incidents.</p>';
    return;
  }

  activeEventsEl.innerHTML = events
    .map((event) => {
      const payloadEntries = Object.entries(event.payload || {});
      const payload = payloadEntries.length
        ? payloadEntries
            .map(([key, value]) => `<code>${escapeHtml(key)}</code>: ${escapeHtml(value)}`)
            .join("<br />")
        : "No additional context provided.";

      return `
        <article class="event-chip">
          <small>${escapeHtml(EVENT_TYPE_LABELS[event.event_type] || titleCase(event.event_type))}</small>
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
    return sceneState.roadMaterials.blocked;
  }
  if (edge.congestion > 20) {
    return sceneState.roadMaterials.congested;
  }
  return sceneState.roadMaterials.stable;
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

function upsertRoads(edges, nodeById) {
  const seen = new Set();
  edges.forEach((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      return;
    }

    seen.add(edge.edge_id);

    let road = sceneState.roadMeshesById.get(edge.edge_id);
    if (!road) {
      road = new THREE.Mesh(sceneState.roadGeometry, roadMaterial(edge));
      road.castShadow = true;
      road.receiveShadow = true;
      sceneState.roadsGroup.add(road);
      sceneState.roadMeshesById.set(edge.edge_id, road);
    }

    const dx = target.sceneX - source.sceneX;
    const dz = target.sceneZ - source.sceneZ;
    const length = Math.hypot(dx, dz);
    const width = Math.min(5.8, 1.8 + edge.congestion / 10);
    road.material = roadMaterial(edge);
    road.scale.set(width, 1, length);
    road.position.set((source.sceneX + target.sceneX) / 2, 0.45, (source.sceneZ + target.sceneZ) / 2);
    road.rotation.y = Math.atan2(dx, dz);
  });

  Array.from(sceneState.roadMeshesById.entries()).forEach(([edgeId, road]) => {
    if (seen.has(edgeId)) {
      return;
    }
    sceneState.roadsGroup.remove(road);
    sceneState.roadMeshesById.delete(edgeId);
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

function updateAlerts(events, nodeById, edgeById) {
  clearGroup(sceneState.alertsGroup);
  events.forEach((event, index) => {
    const alert = new THREE.Mesh(sceneState.alertGeometry, sceneState.alertMaterial);
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
    sceneState.alertsGroup.add(alert);
  });
}

function computeCurvePoint(controlPoints, t) {
  const inv = 1 - t;
  const [p0, p1, p2] = controlPoints;
  return new THREE.Vector3(
    inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
    inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y,
    inv * inv * p0.z + 2 * inv * t * p1.z + t * t * p2.z,
  );
}

function computeCurveTangent(controlPoints, t) {
  const [p0, p1, p2] = controlPoints;
  return new THREE.Vector3(
    2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
    2 * (1 - t) * (p1.z - p0.z) + 2 * t * (p2.z - p1.z),
  ).normalize();
}

function addVehicles(residents, edges, edgeById, nodeById) {
  const seenVehicleKeys = new Set();
  const movingResidents = residents
    .filter((resident) => resident.moving_edge_id && edgeById.has(resident.moving_edge_id))
    .sort((left, right) => String(left.resident_id).localeCompare(String(right.resident_id)));
  const edgeDemand = new Map();
  movingResidents.forEach((resident) => {
    const edgeId = String(resident.moving_edge_id);
    const count = edgeDemand.get(edgeId) || 0;
    edgeDemand.set(edgeId, count + 1);
  });

  const vehiclesToRender = movingResidents.map((resident, index) => {
    const residentId = String(resident.resident_id || `${resident.current_node_id}-${resident.moving_edge_id}-${resident.mode}-${index}`);
    let hash = 0;
    for (let characterIndex = 0; characterIndex < residentId.length; characterIndex += 1) {
      hash = (hash * 31 + residentId.charCodeAt(characterIndex)) % 997;
    }
    return {
      edgeId: String(resident.moving_edge_id),
      representative: resident,
      laneOffset: hash % 4,
      synthetic: false,
      vehicleKey: `resident:${residentId}`,
    };
  });

  edges.forEach((edge) => {
    const movingDemand = edgeDemand.get(edge.edge_id) || 0;
    const congestionDemand = Math.max(0, Math.ceil(Number(edge.congestion || 0) / 12));
    const syntheticNeeded = Math.max(0, congestionDemand - Math.ceil(movingDemand / 3));
    if (!syntheticNeeded) {
      return;
    }

    const source = nodeById.get(edge.source);
    if (!source) {
      return;
    }

    const syntheticRepresentative = {
      mode: "car",
      moving_total_seconds: 1,
      moving_remaining_seconds: 1,
    };

    for (let i = 0; i < Math.min(6, syntheticNeeded); i += 1) {
      vehiclesToRender.push({
        edgeId: edge.edge_id,
        representative: syntheticRepresentative,
        laneOffset: i,
        synthetic: true,
        vehicleKey: `synthetic:${edge.edge_id}:${i}`,
      });
    }
  });

  vehicleCountEl.textContent = formatNumber(movingResidents.length, 0);

  vehiclesToRender.forEach((vehicleState, index) => {
    const edge = edgeById.get(vehicleState.edgeId);
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

    const vehicleKey = vehicleState.vehicleKey;
    seenVehicleKeys.add(vehicleKey);
    let vehicle = sceneState.vehicleMeshesByKey.get(vehicleKey);
    if (!vehicle) {
      const material =
        vehicleState.representative.mode === "car"
          ? sceneState.vehicleMaterials.car
          : vehicleState.representative.mode === "public_transport"
            ? sceneState.vehicleMaterials.public_transport
            : sceneState.vehicleMaterials.other;
      vehicle = new THREE.Mesh(sceneState.vehicleGeometry, material);
      vehicle.castShadow = true;
      vehicle.receiveShadow = true;
      sceneState.vehiclesGroup.add(vehicle);
      sceneState.vehicleMeshesByKey.set(vehicleKey, vehicle);
    }

    const progress =
      vehicleState.representative.moving_total_seconds > 0
        ? 1 - vehicleState.representative.moving_remaining_seconds / vehicleState.representative.moving_total_seconds
        : ((index * 7) % 100) / 100;
    const nextOffset = Math.min(0.98, Math.max(0.02, progress + vehicleState.laneOffset * 0.03));
    const previousState = vehicle.userData || {};
    const previousOffset =
      previousState.edgeId === vehicleState.edgeId
        ? Number(previousState.toOffset ?? previousState.offset ?? nextOffset)
        : nextOffset;

    const p0 = new THREE.Vector3(source.sceneX, 0.6, source.sceneZ);
    const p1 = new THREE.Vector3((source.sceneX + target.sceneX) / 2, 0.85, (source.sceneZ + target.sceneZ) / 2);
    const p2 = new THREE.Vector3(target.sceneX, 0.6, target.sceneZ);

    vehicle.userData = {
      offset: nextOffset,
      fromOffset: previousOffset,
      toOffset: nextOffset,
      vehicleKey,
      edgeId: vehicleState.edgeId,
      controlPoints: [p0, p1, p2],
    };
    vehicle.position.y += (vehicleState.laneOffset % 3) * 0.02;
  });

  Array.from(sceneState.vehicleMeshesByKey.entries()).forEach(([vehicleKey, mesh]) => {
    if (seenVehicleKeys.has(vehicleKey)) {
      return;
    }
    sceneState.vehiclesGroup.remove(mesh);
    sceneState.vehicleMeshesByKey.delete(vehicleKey);
  });

  sceneState.vehicleMeshes = Array.from(sceneState.vehicleMeshesByKey.values());
}

function applyWeather(weather) {
  const weatherKey = String(weather).toLowerCase();
  const preset = WEATHER_PRESETS[weatherKey] || WEATHER_PRESETS.clear;
  sceneState.scene.background.setHex(preset.background);
  sceneState.scene.fog.color.setHex(preset.fog);
  sceneState.ambientLight.intensity = preset.ambient;
  sceneState.sunLight.intensity = preset.sun;
  sceneStateEl.textContent = preset.sceneLabel;

  if (sceneState.currentWeatherKey === weatherKey) {
    return;
  }

  sceneState.currentWeatherKey = weatherKey;

  clearGroup(sceneState.atmosphereGroup);
  sceneState.weatherParticles = [];

  if (preset === WEATHER_PRESETS.clear) {
    return;
  }

  const particleCount = preset === WEATHER_PRESETS.snow ? 180 : 140;
  const weatherMaterial = preset === WEATHER_PRESETS.snow ? sceneState.weatherMaterials.snow : sceneState.weatherMaterials.rain;

  for (let index = 0; index < particleCount; index += 1) {
    const particle = new THREE.Mesh(sceneState.weatherParticleGeometry, weatherMaterial);
    particle.scale.y = preset === WEATHER_PRESETS.snow ? 0.15 : 1.4;
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
    clearGroup(sceneState.flowGroup);
    sceneState.vehicleMeshes = [];
    sceneState.roadMeshesById.clear();
    sceneState.vehicleMeshesByKey.clear();
    sceneState.staticGraphSignature = null;
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

  const graphSignature = `${projectedNodes.map((node) => node.node_id).join(",")}::${edges
    .map((edge) => edge.edge_id)
    .join(",")}`;

  if (sceneState.staticGraphSignature !== graphSignature) {
    clearGroup(sceneState.cityGroup);
    addBuildings(projectedNodes);
    addParks(projectedNodes);
    addHubs(projectedNodes, residentsByNode);
    sceneState.staticGraphSignature = graphSignature;
  }

  upsertRoads(edges, nodeById);
  updateAlerts(state.active_events || [], nodeById, edgeById);
  addVehicles(residents, edges, edgeById, nodeById);
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
  populateTargetSelect(config);
  payloadTargetEl.setAttribute("aria-label", config.targetLabel);
  const optionCount = getTargetOptions(config).length;
  if (config.source === "none") {
    eventHintEl.textContent = config.hint;
    return;
  }
  eventHintEl.textContent = `${config.hint} ${config.targetLabel} options: ${optionCount}.`;
}

async function refresh(successMessage = "Live data synchronized.") {
  const runId = activeRunId;
  try {
    const data = await requestJson("/api/state", {}, successMessage === null ? null : "Fetching live simulation state...");
    if (runId !== activeRunId) {
      return;
    }
    const nextTimeSeconds = Number(data.state?.sim_time_seconds ?? -1);
    if (Number.isFinite(nextTimeSeconds) && nextTimeSeconds < lastAppliedTimeSeconds) {
      interpolationState.previousTimeSeconds = null;
      interpolationState.currentTimeSeconds = null;
      interpolationState.previousAtMs = null;
      interpolationState.currentAtMs = null;
      lastAppliedTimeSeconds = -1;
    }
    if (Number.isFinite(nextTimeSeconds) && nextTimeSeconds >= lastAppliedTimeSeconds) {
      markSnapshotArrival(nextTimeSeconds);
      applyState(data.state);
      lastAppliedTimeSeconds = nextTimeSeconds;
    }
    if (successMessage !== null) {
      setStatus(successMessage, "ok");
    }
  } catch {}
}

async function initializeRuntime() {
  try {
    const data = await requestJson("/api/runtime", {}, null);
    const runtime = data.runtime || {};
    liveState.running = Boolean(runtime.running);
    const speed = Number(runtime.speed_multiplier || 1);
    if (Number.isFinite(speed) && speed > 0) {
      const normalized = Math.min(10, Math.max(1, Math.round(speed)));
      liveSpeedEl.value = String(normalized);
    }
    setLiveUiState();
  } catch {
    liveState.running = true;
    setLiveUiState();
  }
}

updateEventHints();
initializeRuntime().finally(async () => {
  await refresh();
  scheduleStatePolling(STATE_POLL_MS);
});
