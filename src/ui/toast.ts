let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string): void {
  current?.remove();
  if (timer) clearTimeout(timer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  current = el;
  timer = setTimeout(() => {
    el.remove();
    if (current === el) current = null;
  }, 2600);
}
