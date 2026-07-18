// Детерминистичный пиксель-аватар: 8×8 сетка, левая половина по хешу адреса,
// правая — зеркало (получается симметричный «identicon»). Палитра —
// hue из хеша, ограниченная нашей акцентной областью (фиолет↔синь).
// Никаких зависимостей — обычная строковая хеш-функция.
import { useMemo } from 'react';

function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function nextRandom(seed: number): [number, () => number] {
  let s = seed || 1;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  return [seed, next];
}

export function Avatar(props: { seed: string; size?: number; radius?: number }) {
  const size = props.size ?? 40;
  const radius = props.radius ?? 12;
  const cells = 8;
  const half = cells / 2;

  const svg = useMemo(() => {
    const h = hash32(props.seed);
    const [, rnd] = nextRandom(h);
    // Хью в диапазоне 240–280 = сине-фиолетовый диапазон бренда.
    const hue = 240 + Math.floor(rnd() * 40);
    const bg = `hsl(${hue}, 40%, 12%)`;
    const fg1 = `hsl(${hue - 15}, 75%, 62%)`;
    const fg2 = `hsl(${hue + 20}, 78%, 66%)`;
    const cellSize = 100 / cells;
    const rects: string[] = [];
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < half; x++) {
        const on = rnd() < 0.5;
        if (!on) continue;
        const color = rnd() < 0.5 ? fg1 : fg2;
        const rx = x * cellSize;
        const mx = (cells - 1 - x) * cellSize;
        const ry = y * cellSize;
        rects.push(
          `<rect x="${rx}" y="${ry}" width="${cellSize}" height="${cellSize}" fill="${color}"/>`,
        );
        if (x !== cells - 1 - x) {
          rects.push(
            `<rect x="${mx}" y="${ry}" width="${cellSize}" height="${cellSize}" fill="${color}"/>`,
          );
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="${bg}"/>${rects.join('')}</svg>`;
  }, [props.seed]);

  return (
    <span
      className="avatar"
      style={{ width: size, height: size, borderRadius: radius }}
      // Дом-строка — SVG собран нами, не пользовательский ввод.
      dangerouslySetInnerHTML={{ __html: svg }}
      aria-hidden="true"
    />
  );
}
