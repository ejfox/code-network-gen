// Utility functions
function processData(data, settings) {
  const cleaned = cleanData(data);
  const filtered = filterData(cleaned, settings);
  return transformData(filtered);
}

function cleanData(data) {
  return data.filter(item => item && item.id);
}

function filterData(data, settings) {
  return data.filter(item => item.active || settings.includeInactive);
}

function transformData(data) {
  return data.map(formatItem);
}

function formatItem(item) {
  return {
    id: item.id,
    name: item.name?.toUpperCase(),
    timestamp: new Date().toISOString()
  };
}

function displayResult(result) {
  console.log('Processing complete:', result.length, 'items');
}

module.exports = { 
  processData, 
  cleanData, 
  filterData, 
  transformData, 
  formatItem,
  displayResult 
};