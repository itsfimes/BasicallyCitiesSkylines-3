export function drawSparkline(
  canvas: HTMLCanvasElement,
  data: number[],
  color: string,
  maxPoints = 60,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const points = data.slice(-maxPoints);
  if (points.length < 2) return;

  const max = Math.max(...points, 0.01);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";

  points.forEach((val, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((val - min) / range) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(")", ", 0.1)").replace("rgb", "rgba");
  ctx.fill();
}

export function createSparklineCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "sparkline-canvas";
  canvas.style.width = "100%";
  canvas.style.height = "32px";
  return canvas;
}
