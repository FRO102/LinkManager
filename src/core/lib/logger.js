'use strict';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// In a real app, this would come from config.js
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

function formatMessage(level, message, ...args) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${message} ${args.length ? JSON.stringify(args) : ''}`;
}

const logger = {
  debug: (msg, ...args) => {
    if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.DEBUG) {
      console.debug(formatMessage('DEBUG', msg, ...args));
    }
  },
  info: (msg, ...args) => {
    if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.INFO) {
      console.info(formatMessage('INFO', msg, ...args));
    }
  },
  warn: (msg, ...args) => {
    if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.WARN) {
      console.warn(formatMessage('WARN', msg, ...args));
    }
  },
  error: (msg, ...args) => {
    if (LOG_LEVELS[CURRENT_LOG_LEVEL] <= LOG_LEVELS.ERROR) {
      console.error(formatMessage('ERROR', msg, ...args));
    }
  },
};

module.exports = logger;
