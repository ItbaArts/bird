const winston = require("winston");

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.printf(({ level, message }) => {
      return `[⚔] | ${level.toUpperCase()} | ${message}`;
    })
  ),
  transports: [
    // Console transport
    new winston.transports.Console(),
  ],
});

module.exports = logger;
