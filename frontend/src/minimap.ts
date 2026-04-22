/**
 * Lightweight 2D mini-map renderer.
 *
 * Projects the same graph/resident state used by the 3D scene into a compact
 * canvas overview for quick situational awareness in the dashboard.
 */

interface MiniMapState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

let mmState: MiniMapState | null = null;

/**
 * Create and size mini-map canvas within target container.
 * Used by: frontend/src/main.ts during startup bootstrap.
 */
export function initMiniMap(container: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "mini-map-canvas";
  const ctx = canvas.getContext("2d")!;
  container.appendChild(canvas);

  const ro = new ResizeObserver(() => {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    mmState!.width = canvas.width;
    mmState!.height = canvas.height;
  });
  ro.observe(container);

  mmState = { canvas, ctx, width: canvas.width, height: canvas.height };
}

interface GraphNode {
  node_id: string;
  x: number;
  y: number;
}

interface GraphEdge {
  edge_id: string;
  source: string;
  target: string;
  blocked: boolean;
  congestion: number;
}

interface MovingResident {
  moving_edge_id: string | null;
  current_node_id: string;
}

/**
 * Draw latest graph and moving-resident overlay to mini-map canvas.
 * Used by: frontend/src/main.ts renderOverview() on each applied snapshot.
 */
export function renderMiniMap(
  nodes: GraphNode[],
  edges: GraphEdge[],
  residents: MovingResident[],
): void {
  if (!mmState) return;
  const { ctx, width, height } = mmState;
  if (!width || !height) return;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#111a2e";
  ctx.fillRect(0, 0, width, height);

  if (!nodes.length) return;

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 20;

  const projectX = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - pad * 2);
  const projectY = (y: number) => pad + ((y - minY) / (maxY - minY || 1)) * (height - pad * 2);

  const nodeMap = new Map(nodes.map((n) => [n.node_id, n]));

  ctx.lineWidth = 2;
  for (const edge of edges) {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;

    if (edge.blocked) {
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 3;
    } else if (edge.congestion > 20) {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle = "#3b4a68";
      ctx.lineWidth = 1.5;
    }

    ctx.beginPath();
    ctx.moveTo(projectX(src.x), projectY(src.y));
    ctx.lineTo(projectX(tgt.x), projectY(tgt.y));
    ctx.stroke();
  }

  for (const node of nodes) {
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(projectX(node.x), projectY(node.y), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const movingByNode = new Map<string, number>();
  for (const r of residents) {
    if (r.moving_edge_id) {
      movingByNode.set(r.current_node_id, (movingByNode.get(r.current_node_id) || 0) + 1);
    }
  }

  for (const [nodeId, count] of movingByNode) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const radius = Math.min(12, 3 + count * 0.5);
    ctx.fillStyle = "rgba(59, 130, 246, 0.35)";
    ctx.beginPath();
    ctx.arc(projectX(node.x), projectY(node.y), radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
