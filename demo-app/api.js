// API interface
const utils = require('./utils');

function fetchData() {
  const raw = getRawData();
  return utils.cleanData(raw);
}

function getRawData() {
  // Simulate API call
  return [
    { id: 1, name: 'item1', active: true },
    { id: 2, name: 'item2', active: false },
    { id: 3, name: 'item3', active: true }
  ];
}

function postData(data) {
  const processed = utils.processData(data);
  return sendRequest(processed);
}

function sendRequest(data) {
  console.log('Sending:', data);
  return { success: true, count: data.length };
}

module.exports = { fetchData, getRawData, postData, sendRequest };