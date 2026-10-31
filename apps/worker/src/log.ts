const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
};
