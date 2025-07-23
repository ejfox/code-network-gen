// Main entry point
const utils = require('./utils');
const api = require('./api');
const config = require('./config');

function init() {
  const settings = config.getDefaults();
  const data = api.fetchData();
  return utils.processData(data, settings);
}

function start() {
  console.log('Starting app...');
  const result = init();
  utils.displayResult(result);
}

module.exports = { init, start };