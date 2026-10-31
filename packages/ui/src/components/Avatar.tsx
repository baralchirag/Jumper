import { cx } from '../cx';

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  // Keep to warm/neutral hues (no blues or purples).
  return [20, 32, 45, 90, 120, 150, 0][h % 7]!;
}

export function Avatar({ name, src, size = 20, square, className }: { name: string; src?: string | null; size?: number; square?: boolean; className?: string }) {
  const style = { width: size, height: size };
  const shape = square ? 'rounded-md' : 'rounded-full';
  if (src) {
    return <img src={src} alt="" style={style} className={cx(shape, 'shrink-0 bg-canvas-inset object-cover ring-1 ring-border-muted', className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, background: `hsl(${hue(name)} 35% 42%)`, fontSize: Math.max(9, size * 0.45) }}
      className={cx(shape, 'inline-flex shrink-0 items-center justify-center font-semibold uppercase text-white', className)}
    >
      {name.slice(0, 1)}
    </span>
  );
}
