export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/((?:sk-|ds-)[a-zA-Z0-9_-]{8,})/gi, '[REDACTED_API_KEY]'],
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1[REDACTED_TOKEN]'],
  [/((?:Cookie|Authorization|botToken|bot_token|refresh_token|access_token)\s*[=:]\s*)([^\s;,\n"']+)/gi, '$1[REDACTED]'],
  [/^(\/(?:set-quark|set-aliyun|set-115|set-key|set-deepseek|set-webhook)\s+).+$/gim, '$1[REDACTED]'],
  [/(__pus=|__kps=|__kp=|__Host-[^=]+=|UID=|CID=|SEID=)([^;\s]+)/gi, '$1[REDACTED]'],
];

/**
 * 统一对字符串中的 API Key、Cookie、Bearer Token 等敏感凭证进行脱敏
 */
export function maskSensitive(text: string): string {
  if (!text) return '';
  let masked = String(text);
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getMinLevel(): LogLevel {
  if (process.env.DEBUG === 'true') return 'debug';
  const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LEVEL_PRIORITY[envLevel] ? envLevel : 'info';
}

export class Logger {
  private scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
  }

  private formatArgs(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return maskSensitive(a);
        if (a instanceof Error) return maskSensitive(a.message);
        try {
          return maskSensitive(JSON.stringify(a));
        } catch {
          return String(a);
        }
      })
      .join(' ');
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.debug(`[${this.scope}]`, this.formatArgs(args));
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(`[${this.scope}]`, this.formatArgs(args));
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.scope}]`, this.formatArgs(args));
    }
  }

  error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(`[${this.scope}]`, this.formatArgs(args));
    }
  }
}

export function createLogger(scope: string): Logger {
  return new Logger(scope);
}
