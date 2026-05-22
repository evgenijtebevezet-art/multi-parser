type Level = 'info' | 'warn' | 'error' | 'debug';

type LogContext = {
  run_id?: string;
  stage?: string;
};

let globalContext: LogContext = {};

export function setLogContext(ctx: LogContext): void {
  globalContext = { ...globalContext, ...ctx };
}

export function clearLogContext(): void {
  globalContext = {};
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...globalContext,
    ...(fields ?? {}),
  };
  const line = JSON.stringify(entry, (_k, v) => {
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    return v;
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}
