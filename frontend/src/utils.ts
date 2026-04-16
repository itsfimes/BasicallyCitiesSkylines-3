export function formatNumber(value: any, maximumFractionDigits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits });
}

export function formatSimTime(simTimeSeconds: number): string {
  const totalMinutes = Math.max(0, Math.round(simTimeSeconds / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const dayStr = days > 0 ? `D${days} ` : "";
  return `${dayStr}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function titleCase(value: string): string {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function escapeHtml(value: string): string {
  const el = document.createElement("span");
  el.textContent = value;
  return el.innerHTML;
}

export function createElement(
  tag: string,
  attrs: Record<string, string> = {},
  children: (string | Node)[] = [],
): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === "className") {
      el.className = val;
    } else {
      el.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}
