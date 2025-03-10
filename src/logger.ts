// Cloudflare worker-compatible logger

interface LoggerOptions {
  level: string;
}

class CloudflareLogger {
  private level: string;
  private levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
  };

  constructor(options: LoggerOptions = { level: 'info' }) {
    this.level = options.level;
  }

  private shouldLog(level: string): boolean {
    return this.levels[level as keyof typeof this.levels] <= this.levels[this.level as keyof typeof this.levels];
  }

  private formatMessage(level: string, message: string, metadata?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = metadata ? `\n${JSON.stringify(metadata, null, 2)}` : '';
    return `${timestamp} ${level.toUpperCase()}: ${message}${metaStr}`;
  }

  error(message: string, metadata?: any): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, metadata));
    }
  }

  warn(message: string, metadata?: any): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, metadata));
    }
  }

  info(message: string, metadata?: any): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, metadata));
    }
  }

  http(message: string, metadata?: any): void {
    if (this.shouldLog('http')) {
      console.log(this.formatMessage('http', message, metadata));
    }
  }

  verbose(message: string, metadata?: any): void {
    if (this.shouldLog('verbose')) {
      console.log(this.formatMessage('verbose', message, metadata));
    }
  }

  debug(message: string, metadata?: any): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, metadata));
    }
  }

  silly(message: string, metadata?: any): void {
    if (this.shouldLog('silly')) {
      console.log(this.formatMessage('silly', message, metadata));
    }
  }
}

const logger = new CloudflareLogger({ level: 'debug' });

export default logger;