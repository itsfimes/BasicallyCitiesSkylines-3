const API = "http://localhost:8000";

const trafficDensityEl = document.getElementById("trafficDensity");
const avgDelayEl = document.getElementById("avgDelay");
const emissionsEl = document.getElementById("emissions");
const energyEl = document.getElementById("energy");
const mapEl = document.getElementById("map");

document.getElementById("step1").addEventListener("click", () => step(1));
document.getElementById("step10").addEventListener("click", () => step(10));
document.getElementById("run60").addEventListener("click", () => step(60));
document.getElementById("reset").addEventListener("click", resetSimulation);

document.getElementById("eventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const key = form.get("key");
  const value = form.get("value");
  const payload = {};
  if (key && value) {
    payload[key] = value;
  }
  await fetch(`${API}/api/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: String(form.get("event_id")),
      event_type: String(form.get("event_type")),
      duration_minutes: Number(form.get("duration_minutes")),
      payload,
    }),
  });
  await refresh();
});

async function resetSimulation() {
  await fetch(`${API}/api/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seed: 42, resident_count: 2500 }),
  });
  await refresh();
}

async function step(count) {
  const response = await fetch(`${API}/api/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  const data = await response.json();
  const latest = data.metrics[data.metrics.length - 1];
  renderMetrics(latest);
  renderMap(data.state);
}

function renderMetrics(metric) {
  if (!metric) {
    return;
  }
  trafficDensityEl.textContent = String(metric.traffic_density);
  avgDelayEl.textContent = String(metric.avg_delay_minutes);
  emissionsEl.textContent = String(metric.emissions_kg_co2);
  energyEl.textContent = String(metric.energy_kwh);
}

function renderMap(state) {
  const graph = state.graph;
  if (!graph) {
    return;
  }
  const nodes = graph.nodes;
  const edges = graph.edges;

  const xValues = nodes.map((node) => node.x);
  const yValues = nodes.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  const scaleX = (x) => 50 + ((x - minX) / (maxX - minX || 1)) * 800;
  const scaleY = (y) => 450 - ((y - minY) / (maxY - minY || 1)) * 380;

  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));

  const lines = edges
    .map((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) {
        return "";
      }
      const width = Math.min(8, 1 + edge.congestion / 10);
      const color = edge.blocked ? "#d7263d" : edge.congestion > 20 ? "#f08c00" : "#1b6ca8";
      return `<line x1="${scaleX(source.x)}" y1="${scaleY(source.y)}" x2="${scaleX(target.x)}" y2="${scaleY(target.y)}" stroke="${color}" stroke-width="${width}" />`;
    })
    .join("\n");

  const points = nodes
    .map(
      (node) =>
        `<circle cx="${scaleX(node.x)}" cy="${scaleY(node.y)}" r="4" fill="#0a3c5f" /><text x="${scaleX(node.x) + 6}" y="${scaleY(node.y) - 6}" font-size="10">${node.node_id}</text>`,
    )
    .join("\n");

  mapEl.innerHTML = `${lines}\n${points}`;
}

async function refresh() {
  const response = await fetch(`${API}/api/state`);
  const data = await response.json();
  const state = data.state;
  if (state.last_metrics) {
    renderMetrics(state.last_metrics);
  }
  renderMap(data.state);
}

refresh();
