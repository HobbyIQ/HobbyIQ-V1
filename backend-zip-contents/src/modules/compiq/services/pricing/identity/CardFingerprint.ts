// CardFingerprint: generates canonical card keys
// Type-only import removed for CommonJS compatibility
class CardFingerprint {
  static generate(identity: any) {
    // TODO: Deterministically generate canonical key from normalized identity
    return [
      identity.normalized.playerName,
      identity.normalized.cardYear,
      identity.normalized.product,
      identity.normalized.parallel,
      identity.normalized.serialNumber,
      identity.normalized.gradeCompany,
      identity.normalized.gradeValue,
      identity.normalized.isAuto ? 'auto' : '',
      identity.normalized.isPatch ? 'patch' : ''
    ].join('-').toLowerCase();
  }
}

module.exports = { CardFingerprint };
