// CardIdentity and related types

/**
 * @typedef {Object} CardIdentity
 * @property {string} canonicalKey
 * @property {number} matchConfidence
 * @property {Object} normalized
 * @property {string} normalized.playerName
 * @property {number=} normalized.cardYear
 * @property {string=} normalized.brand
 * @property {string=} normalized.setName
 * @property {string=} normalized.product
 * @property {string=} normalized.parallel
 * @property {string=} normalized.serialNumber
 * @property {string=} normalized.variation
 * @property {string=} normalized.gradeCompany
 * @property {number|string=} normalized.gradeValue
 * @property {boolean=} normalized.isAuto
 * @property {boolean=} normalized.isPatch
 * @property {string=} normalized.team
 * @property {string=} normalized.cardNumber
 * @property {string[]=} aliasesUsed
 * @property {string=} notes
 */

/**
 * @typedef {Object} ProvenanceScore
 * @property {number} sourceTrustScore
 * @property {number} parseConfidence
 * @property {number} identityConfidence
 * @property {number} normalizationConfidence
 * @property {number} finalTrustScore
 */

module.exports = {};
