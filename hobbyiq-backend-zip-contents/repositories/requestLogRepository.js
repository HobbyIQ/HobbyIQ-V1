// requestLogRepository.js - Mock/local request log persistence
const logs = [];
function logRequest(entry) {
  logs.push(entry);
  return true;
}
function getAllLogs() {
  return logs;
}
module.exports = { logRequest, getAllLogs };
