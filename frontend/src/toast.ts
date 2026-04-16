interface ToastItem {
  id: number;
  message: string;
  state: "info" | "ok" | "error";
  timer: ReturnType<typeof setTimeout>;
}

const container = document.createElement("div");
container.className = "toast-container";
container.setAttribute("aria-live", "polite");
document.body.appendChild(container);

let nextId = 0;

export function toast(message: string, state: "info" | "ok" | "error" = "info", duration = 4000) {
  const id = nextId++;
  const el = document.createElement("div");
  el.className = `toast toast-${state}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("toast-visible");
  });

  const timer = setTimeout(() => dismiss(id), duration);
  const item: ToastItem = { id, message, state, timer };

  const dismissFn = () => dismiss(id);
  el.addEventListener("click", dismissFn);

  activeToasts.set(id, { ...item, dismiss: dismissFn });
}

const activeToasts = new Map<number, ToastItem & { dismiss: () => void }>();

function dismiss(id: number) {
  const item = activeToasts.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  const el = container.children[Array.from(activeToasts.keys()).indexOf(id)] as HTMLElement;
  if (el) {
    el.classList.remove("toast-visible");
    el.classList.add("toast-exit");
    setTimeout(() => el.remove(), 300);
  }
  activeToasts.delete(id);
}
