const API = "http://localhost:8000";

const EVENT_FIELD_HINTS = {
  accident: {
    key: "edge_id",
    value: "e12",
    hint: "Accident events require an edge target via `edge_id`.",
  },
  road_closure: {
    key: "edge_id",
    value: "e07",
    hint: "Road closures require an `edge_id` payload so the backend can block the route.",
  },
  concert: {
    key: "node_id",
    value: "n3",
    hint: "Concerts must target a destination node via `node_id`.",
  },
  extreme_weather: {
    key: "weather",
    value: "rain",
    hint: "Extreme weather events require a `weather` payload such as rain or snow.",
  },
  outage: {
    key: "payload key",
    value: "district-west",
    hint: "Outages accept optional payload context if you want to tag the disruption.",
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
const nodeCountEl = document.getElementById("nodeCount");
const edgeCountEl = document.getElementById("edgeCount");
const blockedCountEl = document.getElementById("blockedCount");
const statusMessageEl = document.getElementById("statusMessage");
const activeEventsEl = document.getElementById("activeEvents");
const eventCountBadgeEl = document.getElementById("eventCountBadge");
const eventFormEl = document.getElementById("eventForm");
const eventTypeEl = eventFormEl.querySelector('[name="event_type"]');
const payloadKeyEl = eventFormEl.querySelector('[name="key"]');
const payloadValueEl = eventFormEl.querySelector('[name="value"]');
const eventHintEl = document.getElementById("eventHint");

document.getElementById("step1").addEventListener("click", () => step(1));
document.getElementById("step10").addEventListener("click", () => step(10));
document.getElementById("run60").addEventListener("click", () => step(60));
document.getElementById("reset").addEventListener("click", resetSimulation);
eventTypeEl.addEventListener("change", updateEventHints);

eventFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const key = String(form.get("key") || "").trim();
  const value = String(form.get("value") || "").trim();
  const payload = {};
  if (key && value) {
    payload[key] = value;
  }

  try {
    await requestJson(
      "/api/event",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: String(form.get("event_id")),
          event_type: String(form.get("event_type")),
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

function getThemeValue(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
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

function renderOverview(state) {
  simTimeEl.textContent = formatMinute(state.minute);
  weatherStateEl.textContent = titleCase(state.weather);
  eventCountEl.textContent = formatNumber(state.active_events?.length || 0, 0);
  residentCountEl.textContent = formatNumber(state.residents?.length || 0, 0);
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

function renderMap(state) {
  const graph = state.graph;
  if (!graph || !graph.nodes?.length) {
    nodeCountEl.textContent = "0";
    edgeCountEl.textContent = "0";
    blockedCountEl.textContent = "0";
    mapEl.innerHTML =
      '<text x="50%" y="50%" text-anchor="middle" class="node-label">No network data loaded.</text>';
    return;
  }

  const nodes = graph.nodes;
  const edges = graph.edges || [];
  const blockedCount = edges.filter((edge) => edge.blocked).length;
  nodeCountEl.textContent = formatNumber(nodes.length, 0);
  edgeCountEl.textContent = formatNumber(edges.length, 0);
  blockedCountEl.textContent = formatNumber(blockedCount, 0);

  const xValues = nodes.map((node) => node.x);
  const yValues = nodes.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  const scaleX = (x) => 60 + ((x - minX) / (maxX - minX || 1)) * 780;
  const scaleY = (y) => 440 - ((y - minY) / (maxY - minY || 1)) * 340;

  const colors = {
    stable: getThemeValue("--accent-strong", "#2499ff"),
    congested: getThemeValue("--accent-warm", "#f6b64f"),
    blocked: getThemeValue("--danger", "#ff5f73"),
    node: getThemeValue("--accent", "#5cd0ff"),
  };

  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));

  const lines = [...edges]
    .sort((left, right) => Number(left.blocked) - Number(right.blocked) || left.congestion - right.congestion)
    .map((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) {
        return "";
      }
      const width = Math.min(10, 1.4 + edge.congestion / 9);
      const color = edge.blocked
        ? colors.blocked
        : edge.congestion > 20
          ? colors.congested
          : colors.stable;

      return `<line class="edge" x1="${scaleX(source.x)}" y1="${scaleY(source.y)}" x2="${scaleX(
        target.x,
      )}" y2="${scaleY(target.y)}" stroke="${color}" stroke-width="${width}" />`;
    })
    .join("\n");

  const points = nodes
    .map((node) => {
      const x = scaleX(node.x);
      const y = scaleY(node.y);
      return `
        <circle class="node-halo" cx="${x}" cy="${y}" r="11" />
        <circle class="node-core" cx="${x}" cy="${y}" r="4.8" fill="${colors.node}" />
        <text class="node-label" x="${x + 10}" y="${y - 10}">${escapeHtml(node.node_id)}</text>
      `;
    })
    .join("\n");

  mapEl.innerHTML = `${lines}\n${points}`;
}

function applyState(state) {
  renderOverview(state);
  if (state.last_metrics) {
    renderMetrics(state.last_metrics);
  }
  renderMap(state);
}

function updateEventHints() {
  const config = EVENT_FIELD_HINTS[eventTypeEl.value] || EVENT_FIELD_HINTS.outage;
  payloadKeyEl.placeholder = config.key;
  payloadValueEl.placeholder = config.value;
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
