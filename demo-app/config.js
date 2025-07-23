// Configuration
const utils = require('./utils');

function getDefaults() {
  return {
    includeInactive: false,
    maxItems: 100,
    timeout: 5000
  };
}

function validate(settings) {
  if (!settings.maxItems || settings.maxItems <= 0) {
    throw new Error('Invalid maxItems');
  }
  return true;
}

function loadConfig(path) {
  const defaults = getDefaults();
  const loaded = require(path || './config.json');
  const merged = { ...defaults, ...loaded };
  
  validate(merged);
  return merged;
}

module.exports = { getDefaults, validate, loadConfig };