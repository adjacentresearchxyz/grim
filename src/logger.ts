import * as winston from 'winston';

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...metadata }) => {
          const metaStr = Object.keys(metadata).length
            ? `\n${JSON.stringify(metadata, null, 2)}`
            : '';
          return `${timestamp} ${level}: ${message}${metaStr}`;
        })
      )
    })
  ]
});

export default logger; 