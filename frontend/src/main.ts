/**
 * Frontend application orchestrator.
 *
 * Wires UI controls with API/WebSocket data flow, applies simulation snapshots,
 * updates dashboard widgets, and delegates rendering to scene/minimap/sparkline
 * modules.
 */

import { api } from "./api.ts";
import { formatNumber, formatSimTime, titleCase } from "./utils.ts";
import { toast } from "./toast.ts";
import { initScene, updateScene } from "./scene.ts";
import { initMiniMap, renderMiniMap } from "./minimap.ts";
import { drawSparkline, createSparklineCanvas } from "./sparkline.ts";

const EVENT_TYPE_LABELS: Record<string, string> = {
  accident: "Road accident",
  road_closure: "Road closure",
  concert: "Concert surge",
  extreme_weather: "Extreme weather",
  outage: "Infrastructure outage",
};

const EVENT_PAYLOAD_CONFIG: Record<string, {
  key: string;
  required: boolean;
  hint: string;
  targetLabel: string;
  fallback: string;
  source: "nodes" | "edges" | "weather" | "none";
}> = {
  accident: { key: "edge_id", required: true, hint: "Select the edge where the accident occurs.", targetLabel: "Edge", fallback: "No edges available.", source: "edges" },
  road_closure: { key: "edge_id", required: true, hint: "Select the edge to close.", targetLabel: "Edge", fallback: "No edges available.", source: "edges" },
  concert: { key: "node_id", required: true, hint: "Select the node for the concert surge.", targetLabel: "Node", fallback: "No nodes available.", source: "nodes" },
  extreme_weather: { key: "weather", required: true, hint: "Select the weather condition.", targetLabel: "Weather", fallback: "No options.", source: "weather" },
  outage: { key: "district", required: false, hint: "No target needed for outages.", targetLabel: "Scope", fallback: "No target needed.", source: "none" },
};

const WEATHER_OPTIONS = ["rain", "storm", "snow"];

const incidentState = { nodes: [] as string[], edges: [] as string[] };

const els = {
  trafficDensity: document.getElementById("trafficDensity")!,
  avgDelay: document.getElementById("avgDelay")!,
  emissions: document.getElementById("emissions")!,
  energy: document.getElementById("energy")!,
  map: document.getElementById("map")!,
  simTime: document.getElementById("simTime")!,
  weatherState: document.getElementById("weatherState")!,
  eventCount: document.getElementById("eventCount")!,
  residentCount: document.getElementById("residentCount")!,
  movingCount: document.getElementById("movingCount")!,
  delayedCount: document.getElementById("delayedCount")!,
  nodeCount: document.getElementById("nodeCount")!,
  edgeCount: document.getElementById("edgeCount")!,
  blockedCount: document.getElementById("blockedCount")!,
  vehicleCount: document.getElementById("vehicleCount")!,
  networkMood: document.getElementById("networkMood")!,
  sceneState: document.getElementById("sceneState")!,
  statusMessage: document.getElementById("statusMessage")!,
  activeEvents: document.getElementById("activeEvents")!,
  eventCountBadge: document.getElementById("eventCountBadge")!,
  eventForm: document.getElementById("eventForm")! as HTMLFormElement,
  liveToggle: document.getElementById("liveToggle")!,
  liveSpeed: document.getElementById("liveSpeed")! as HTMLSelectElement,
};

const eventTypeEl = els.eventForm.querySelector('[name="event_type"]')! as HTMLSelectElement;
const payloadTargetEl = els.eventForm.querySelector('[name="payload_target"]')! as HTMLSelectElement;
const eventHintEl = document.getElementById("eventHint")!;

const interpolation = {
  prevTime: null as number | null,
  currTime: null as number | null,
  prevAt: null as number | null,
  currAt: null as number | null,
  prevSimDelta: null as number | null,
  currSimDelta: null as number | null,
  prevSpeed: null as number | null,
  currSpeed: null as number | null,
};

let lastAppliedTime = -1;
let lastAppliedTickId = -1;
let lastRunId = 0;
let liveRunning = false;

const metricsHistory = {
  trafficDensity: [] as number[],
  avgDelay: [] as number[],
  emissions: [] as number[],
  energy: [] as number[],
};

const sparklineCanvases = {
  trafficDensity: createSparklineCanvas(),
  avgDelay: createSparklineCanvas(),
  emissions: createSparklineCanvas(),
  energy: createSparklineCanvas(),
};

const sparklineMap: Record<string, string> = {
  trafficDensity: "density",
  avgDelay: "delay",
  emissions: "emissions",
  energy: "energy",
};

for (const [key, canvas] of Object.entries(sparklineCanvases)) {
  const card = document.querySelector(`.mc-${sparklineMap[key]} .mc-spark`);
  if (card) card.appendChild(canvas);
}

initMiniMap(document.getElementById("miniMap")!);

const sceneRef = initScene(els.map, getInterpolationAlpha, els.sceneState, els.vehicleCount);

/**
 * Compute interpolation alpha between latest two simulation snapshots.
 * Used by: frontend/src/scene.ts animation loop to smooth vehicle positions
 * between websocket/API state arrivals.
 */
function getInterpolationAlpha(): number {
  if (interpolation.prevTime == null || interpolation.currTime == null) return 1;
  const simDelta = interpolation.currTime - interpolation.prevTime;
  if (simDelta <= 0) return 1;
  const prevAt = interpolation.prevAt ?? interpolation.currAt ?? performance.now();
  const currAt = interpolation.currAt ?? prevAt;
  const speed = interpolation.currSpeed ?? interpolation.prevSpeed ?? Number(els.liveSpeed.value || 1);
  const deltaFromTiming = interpolation.currSimDelta ?? simDelta;
  const expectedMs = (1000 * Math.max(0.05, deltaFromTiming)) / Math.max(0.25, speed);
  const arrivalDelta = Math.max(expectedMs, (currAt as number) - (prevAt as number));
  const elapsed = Math.max(0, performance.now() - (currAt as number));
  return Math.min(1, elapsed / arrivalDelta);
}

/**
 * Shift interpolation anchors when a newer snapshot arrives.
 * Used by: refresh() and websocket tick handler before applyState().
 */
function markSnapshot(timeSec: number, timing?: { sim_delta_seconds?: number; speed_multiplier?: number } | null) {
  const now = performance.now();
  if (interpolation.currTime != null) {
    interpolation.prevTime = interpolation.currTime;
    interpolation.prevAt = interpolation.currAt;
    interpolation.prevSimDelta = interpolation.currSimDelta;
    interpolation.prevSpeed = interpolation.currSpeed;
  }
  interpolation.currTime = timeSec;
  interpolation.currAt = now;
  const timingDelta = Number(timing?.sim_delta_seconds ?? NaN);
  interpolation.currSimDelta = Number.isFinite(timingDelta) && timingDelta > 0 ? timingDelta : null;
  const timingSpeed = Number(timing?.speed_multiplier ?? NaN);
  interpolation.currSpeed = Number.isFinite(timingSpeed) && timingSpeed > 0 ? timingSpeed : null;
  if (interpolation.prevTime == null || timeSec < interpolation.prevTime) {
    interpolation.prevTime = timeSec;
    interpolation.prevAt = now;
    interpolation.prevSimDelta = interpolation.currSimDelta;
    interpolation.prevSpeed = interpolation.currSpeed;
  }
}

/**
 * Derive a qualitative network label from congestion/event state.
 * Used by: renderOverview() dashboard summary card.
 */
function describeNetworkMood(state: any): string {
  const blocked = state.graph?.edges?.filter((e: any) => e.blocked).length || 0;
  const density = Number(state.last_metrics?.traffic_density || 0);
  const events = state.active_events?.length || 0;
  if (blocked > 0) return "Network disrupted";
  if (events > 0 || density > 25) return "Increasing congestion";
  if (density > 12) return "Heavy commuter traffic";
  return "Steady traffic flow";
}

/**
 * Render KPI values and update in-memory sparkline history.
 * Used by: applyState() whenever backend metrics are present.
 */
function renderMetrics(m: any) {
  if (!m) return;
  els.trafficDensity.textContent = formatNumber(m.traffic_density);
  els.avgDelay.textContent = formatNumber(m.avg_delay_minutes);
  els.emissions.textContent = formatNumber(m.emissions_kg_co2);
  els.energy.textContent = formatNumber(m.energy_kwh);

  metricsHistory.trafficDensity.push(m.traffic_density);
  metricsHistory.avgDelay.push(m.avg_delay_minutes);
  metricsHistory.emissions.push(m.emissions_kg_co2);
  metricsHistory.energy.push(m.energy_kwh);
  if (metricsHistory.trafficDensity.length > 120) {
    metricsHistory.trafficDensity.shift();
    metricsHistory.avgDelay.shift();
    metricsHistory.emissions.shift();
    metricsHistory.energy.shift();
  }

  drawSparkline(sparklineCanvases.trafficDensity, metricsHistory.trafficDensity, "rgb(59, 130, 246)");
  drawSparkline(sparklineCanvases.avgDelay, metricsHistory.avgDelay, "rgb(245, 158, 11)");
  drawSparkline(sparklineCanvases.emissions, metricsHistory.emissions, "rgb(239, 68, 68)");
  drawSparkline(sparklineCanvases.energy, metricsHistory.energy, "rgb(16, 185, 129)");
}

/**
 * Render active incident chips in the right-side events panel.
 * Used by: renderOverview() after each applied snapshot.
 */
function renderActiveEvents(events: any[]) {
  els.eventCountBadge.textContent = `${events.length} live`;
  while (els.activeEvents.firstChild) els.activeEvents.removeChild(els.activeEvents.firstChild);
  if (!events.length) {
    const p = document.createElement("p");
    p.className = "event-empty";
    p.textContent = "No active incidents.";
    els.activeEvents.appendChild(p);
    return;
  }
  for (const event of events) {
    const chip = document.createElement("article");
    chip.className = "event-chip";
    const typeLabel = EVENT_TYPE_LABELS[event.event_type] || titleCase(event.event_type);
    chip.appendChild(Object.assign(document.createElement("small"), { textContent: typeLabel }));
    chip.appendChild(Object.assign(document.createElement("strong"), { textContent: event.event_id }));
    chip.appendChild(Object.assign(document.createElement("small"), { textContent: `Duration: ${event.duration_minutes} min` }));
    const payloadEntries = Object.entries(event.payload || {});
    if (payloadEntries.length) {
      const payloadSmall = document.createElement("small");
      payloadSmall.textContent = payloadEntries.map(([k, v]) => `${k}: ${v}`).join(", ");
      chip.appendChild(payloadSmall);
    }
    els.activeEvents.appendChild(chip);
  }
}

/**
 * Render overview counters, weather/time labels, and minimap source state.
 * Used by: applyState() as primary UI update pass for each snapshot.
 */
function renderOverview(state: any) {
  const residents = state.residents || [];
  const summary = state.resident_summary;
  const moving = summary?.moving ?? residents.filter((r: any) => r.moving_edge_id).length;
  const delayed = summary?.delayed ?? residents.filter((r: any) => r.delayed_minutes > 0).length;

  els.simTime.textContent = formatSimTime(state.sim_time_seconds);
  els.weatherState.textContent = titleCase(state.weather);
  els.eventCount.textContent = formatNumber(state.active_events?.length || 0, 0);
  els.residentCount.textContent = formatNumber(summary?.total ?? residents.length, 0);
  els.movingCount.textContent = formatNumber(moving, 0);
  els.delayedCount.textContent = formatNumber(delayed, 0);
  els.networkMood.textContent = describeNetworkMood(state);
  renderActiveEvents(state.active_events || []);

  incidentState.nodes = (state.graph?.nodes || []).map((n: any) => n.node_id);
  incidentState.edges = (state.graph?.edges || []).map((e: any) => e.edge_id);
  updateEventHints();

  renderMiniMap(
    state.graph?.nodes || [],
    state.graph?.edges || [],
    residents,
  );
}

/**
 * Apply one backend snapshot to all frontend render targets.
 * Used by: refresh() pull updates and websocket tick push updates.
 */
function applyState(state: any) {
  renderOverview(state);
  if (state.last_metrics) renderMetrics(state.last_metrics);

  if (state.metrics_history) {
    const hist = state.metrics_history;
    metricsHistory.trafficDensity = hist.map((m: any) => m.traffic_density);
    metricsHistory.avgDelay = hist.map((m: any) => m.avg_delay_minutes);
    metricsHistory.emissions = hist.map((m: any) => m.emissions_kg_co2);
    metricsHistory.energy = hist.map((m: any) => m.energy_kwh);
  }

  const graph = state.graph;
  if (graph?.nodes?.length) {
    const stats = updateScene(graph, state.residents || [], state.active_events || [], state.weather, new Map());
    if (stats) {
      els.nodeCount.textContent = formatNumber(stats.nodeCount, 0);
      els.edgeCount.textContent = formatNumber(stats.edgeCount, 0);
      els.blockedCount.textContent = formatNumber(stats.blockedCount, 0);
    }
  }
}

/**
 * Resolve selectable target values for current event payload type.
 * Used by: populateTargetSelect() to build event form options.
 */
function getTargetOptions(config: typeof EVENT_PAYLOAD_CONFIG[string]): string[] {
  if (config.source === "nodes") return incidentState.nodes;
  if (config.source === "edges") return incidentState.edges;
  if (config.source === "weather") return WEATHER_OPTIONS;
  return [];
}

/**
 * Populate payload target select based on event-type configuration.
 * Used by: updateEventHints() when event type or graph options change.
 */
function populateTargetSelect(config: typeof EVENT_PAYLOAD_CONFIG[string]) {
  payloadTargetEl.innerHTML = "";
  if (config.source === "none") {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No target needed";
    payloadTargetEl.appendChild(opt);
    payloadTargetEl.disabled = true;
    payloadTargetEl.required = false;
    return;
  }
  const options = getTargetOptions(config);
  if (!options.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = config.fallback;
    payloadTargetEl.appendChild(opt);
    payloadTargetEl.disabled = true;
    payloadTargetEl.required = false;
    return;
  }
  payloadTargetEl.disabled = false;
  payloadTargetEl.required = config.required;
  for (const val of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    payloadTargetEl.appendChild(opt);
  }
}

/**
 * Refresh event form helper text and target selector accessibility label.
 * Used by: event type change handler and overview refresh pipeline.
 */
function updateEventHints() {
  const config = EVENT_PAYLOAD_CONFIG[eventTypeEl.value] || EVENT_PAYLOAD_CONFIG.outage;
  populateTargetSelect(config);
  payloadTargetEl.setAttribute("aria-label", config.targetLabel);
  const count = getTargetOptions(config).length;
  eventHintEl.textContent = config.source === "none" ? config.hint : `${config.hint} ${config.targetLabel} options: ${count}.`;
}

/**
 * Set status banner text and UI state marker.
 * Used by: runtime sync, refresh success/failure, and control actions.
 */
function setStatus(message: string, state = "idle") {
  els.statusMessage.textContent = message;
  els.statusMessage.dataset.state = state;
}

/**
 * Pull full state snapshot from REST and apply if it is not stale.
 * Used by: startup bootstrap, post-action refreshes, and fallback syncing when
 * websocket ticks are not sufficient.
 */
async function refresh(successMessage = "Live data synchronized.") {
  try {
    const data = await api.request("/api/state");
    const nextTime = Number(data.state?.sim_time_seconds ?? -1);
    const nextRunId = Number(data.run_id ?? lastRunId);
    const nextTickId = Number(data.tick_id ?? lastAppliedTickId);
    if (Number.isFinite(nextRunId) && nextRunId !== lastRunId) {
      interpolation.prevTime = null;
      interpolation.currTime = null;
      interpolation.prevAt = null;
      interpolation.currAt = null;
      interpolation.prevSimDelta = null;
      interpolation.currSimDelta = null;
      interpolation.prevSpeed = null;
      interpolation.currSpeed = null;
      lastAppliedTime = -1;
      lastAppliedTickId = -1;
      lastRunId = nextRunId;
    }
    if (Number.isFinite(nextTime) && nextTime < lastAppliedTime) {
      interpolation.prevTime = null;
      interpolation.currTime = null;
      interpolation.prevAt = null;
      interpolation.currAt = null;
      interpolation.prevSimDelta = null;
      interpolation.currSimDelta = null;
      interpolation.prevSpeed = null;
      interpolation.currSpeed = null;
      lastAppliedTime = -1;
      lastAppliedTickId = -1;
    }
    const tickMonotonic = !Number.isFinite(nextTickId) || nextTickId >= lastAppliedTickId;
    if (Number.isFinite(nextTime) && nextTime >= lastAppliedTime && tickMonotonic) {
      markSnapshot(nextTime, data.timing);
      applyState(data.state);
      lastAppliedTime = nextTime;
      if (Number.isFinite(nextTickId)) {
        lastAppliedTickId = nextTickId;
      }
    }
    if (successMessage) {
      setStatus(successMessage, "ok");
    }
  } catch (err: any) {
    setStatus(err.message, "error");
  }
}

/**
 * Push live-mode and speed settings to backend runtime.
 * Used by: live toggle and speed selector handlers.
 */
async function syncRuntime() {
  try {
    const data = await api.request("/api/runtime", {
      method: "POST",
      body: JSON.stringify({ running: liveRunning, speed_multiplier: Number(els.liveSpeed.value || 1) }),
    });
    const rt = data.runtime || {};
    liveRunning = Boolean(rt.running);
    els.liveToggle.textContent = liveRunning ? "Pause Live" : "Resume Live";
    setStatus(`Live mode ${liveRunning ? "running" : "paused"} at ${els.liveSpeed.value}x.`, "ok");
  } catch {
    setStatus("Failed to update live controls.", "error");
  }
}

/**
 * Fetch backend runtime status and initialize control defaults.
 * Used by: startup flow before first refresh/connectWebSocket.
 */
async function initializeRuntime() {
  try {
    const data = await api.request("/api/runtime");
    const rt = data.runtime || {};
    liveRunning = Boolean(rt.running);
    const speed = Number(rt.speed_multiplier || 1);
    if (Number.isFinite(speed) && speed > 0) {
      els.liveSpeed.value = String(Math.min(10, Math.max(1, Math.round(speed))));
    }
    const runId = Number(rt.run_id ?? NaN);
    if (Number.isFinite(runId)) {
      lastRunId = runId;
    }
    const tickId = Number(rt.tick_id ?? NaN);
    if (Number.isFinite(tickId)) {
      lastAppliedTickId = tickId;
    }
    els.liveToggle.textContent = liveRunning ? "Pause Live" : "Resume Live";
  } catch {
    liveRunning = true;
    els.liveToggle.textContent = "Pause Live";
  }
}

els.liveToggle.addEventListener("click", () => {
  liveRunning = !liveRunning;
  els.liveToggle.textContent = liveRunning ? "Pause Live" : "Resume Live";
  syncRuntime();
});

els.liveSpeed.addEventListener("change", syncRuntime);

document.getElementById("reset")!.addEventListener("click", async () => {
  try {
    await api.request("/api/reset", {
      method: "POST",
      body: JSON.stringify({ seed: 42, resident_count: 2500 }),
    });
    lastAppliedTime = -1;
    interpolation.prevTime = null;
    interpolation.currTime = null;
    interpolation.prevAt = null;
    interpolation.currAt = null;
    toast("Simulation reset to baseline.", "ok");
    await refresh("Simulation reset.");
    await syncRuntime();
  } catch (err: any) {
    toast(err.message, "error");
  }
});

eventTypeEl.addEventListener("change", updateEventHints);

els.eventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const eventType = String(form.get("event_type"));
  const config = EVENT_PAYLOAD_CONFIG[eventType] || EVENT_PAYLOAD_CONFIG.outage;
  const payloadTarget = String(form.get("payload_target") || "").trim();
  const payload: Record<string, string> = {};
  const label = EVENT_TYPE_LABELS[eventType] || titleCase(eventType);

  if (config.required && !payloadTarget) {
    toast(`Please select a ${config.targetLabel.toLowerCase()} for ${label}.`, "error");
    payloadTargetEl.reportValidity();
    payloadTargetEl.focus();
    return;
  }

  if (payloadTarget) payload[config.key] = payloadTarget;

  const safeTarget = String(payloadTarget || "target").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const eventId = `${eventType}-${safeTarget || "target"}-${Date.now()}`;

  try {
    await api.request("/api/event", {
      method: "POST",
      body: JSON.stringify({
        event_id: eventId,
        event_type: eventType,
        duration_minutes: Number(form.get("duration_minutes")),
        payload,
      }),
    });
    toast(`${label} injected successfully.`, "ok");
    (event.currentTarget as HTMLFormElement).reset();
    updateEventHints();
    await refresh("Incident injected.");
  } catch (err: any) {
    toast(err.message, "error");
  }
});

api.onMessage((data) => {
  if (data.type === "tick" && data.state) {
    const nextTime = Number(data.state.sim_time_seconds ?? -1);
    const nextRunId = Number(data.run_id ?? NaN);
    if (Number.isFinite(nextRunId) && nextRunId !== lastRunId) {
      lastRunId = nextRunId;
      lastAppliedTime = -1;
      lastAppliedTickId = -1;
      interpolation.prevTime = null;
      interpolation.currTime = null;
      interpolation.prevAt = null;
      interpolation.currAt = null;
      interpolation.prevSimDelta = null;
      interpolation.currSimDelta = null;
      interpolation.prevSpeed = null;
      interpolation.currSpeed = null;
    }
    const tickId = Number(data.tick_id ?? NaN);
    const tickMonotonic = !Number.isFinite(tickId) || tickId > lastAppliedTickId;
    if (Number.isFinite(nextTime) && nextTime >= lastAppliedTime && tickMonotonic) {
      markSnapshot(nextTime, data.timing);
      applyState(data.state);
      lastAppliedTime = nextTime;
      if (Number.isFinite(tickId)) {
        lastAppliedTickId = tickId;
      }
    }
  }
});

window.addEventListener("error", (event) => {
  toast(`Error: ${event.message}`, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  toast(`Async error: ${event.reason?.message || event.reason}`, "error");
});

updateEventHints();
initializeRuntime().finally(async () => {
  await refresh();
  api.connectWebSocket();
});
