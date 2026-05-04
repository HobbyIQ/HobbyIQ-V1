// storageInterfaces.js - Storage interface definitions
// For future DB integration (Azure SQL, Cosmos, etc.)

/**
 * @typedef {Object} CompRepository
 * @property {function(): Array} getAllComps
 * @property {function(Object): boolean} saveComp
 */

/**
 * @typedef {Object} PricingRepository
 * @property {function(Object): boolean} savePricingResult
 * @property {function(): Array} getAllPricingResults
 */

/**
 * @typedef {Object} RequestLogRepository
 * @property {function(Object): boolean} logRequest
 * @property {function(): Array} getAllLogs
 */
