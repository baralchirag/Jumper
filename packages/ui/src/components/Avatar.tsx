import { cx } from '../cx';

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  // Material tones from a board: copper, solder mask green, FR4 tan, silkscreen grey, gold.
  return [22, 150, 40, 95, 160, 30, 60][h % 7]!;
}

export function Avatar({ name, src, size = 20, square, className }: { name: string; src?: string | null; size?: number; square?: boolean; className?: string }) {
  const style = { width: size, height: size };
  const shape = square ? 'rounded-sm' : 'rounded-full';
  if (src) {
    return <img src={src} alt="" style={style} className={cx(shape, 'shrink-0 bg-canvas-inset object-cover ring-1 ring-border', className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, background: `hsl(${hue(name)} 28% 30%)`, fontSize: Math.max(9, size * 0.42) }}
      className={cx(shape, 'inline-flex shrink-0 items-center justify-center font-mono font-medium uppercase text-[#ede9e3] ring-1 ring-black/10', className)}
    >
      {name.slice(0, 1)}
    </span>
  );
}
