const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string | Date): string {
  const t = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = (t.getTime() - Date.now()) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return 'just now';
}

export function RelativeTime({ date, className }: { date: string | Date; className?: string }) {
  const d = typeof date === 'string' ? new Date(date) : date;
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className}>
      {relativeTime(d)}
    </time>
  );
}
