// «Что нового»: разделы CHANGELOG.md, который Vite встраивает в сборку как текст.
import text from "../CHANGELOG.md?raw";

export interface Release { version: string; items: string[] }

/** «0.6.1» → [0, 6, 1] для сравнения версий. */
const parts = (v: string) => v.split(".").map((n) => Number(n) || 0);
export function newer(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Пункты списка из куска markdown: «- …» с продолжением на следующих строках. */
export function parseItems(md: string): string[] {
  const items: string[] = [];
  for (const line of md.replace(/\r/g, "").split("\n")) {
    if (/^\s*-\s+/.test(line)) items.push(line.replace(/^\s*-\s+/, ""));
    else if (line.trim() && items.length) items[items.length - 1] += " " + line.trim();
  }
  return items;
}

const releases: Release[] = text.replace(/\r/g, "").split(/^## /m).slice(1).map((chunk) => {
  const [head, ...rest] = chunk.split("\n");
  return { version: head.trim(), items: parseItems(rest.join("\n")) };
});

/** Версии новее `from` и не новее `to`, от новой к старой. */
export function releasesBetween(from: string, to: string): Release[] {
  return releases.filter((r) => newer(r.version, from) && !newer(r.version, to));
}

/** Строка из CHANGELOG.md в HTML: `код` и **жирный**. Текст экранируется. */
export function inline(s: string, esc: (s: string) => string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<span class="mono">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}
