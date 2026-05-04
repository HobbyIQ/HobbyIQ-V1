// CardIdentityEngine
// Type-only import removed for CommonJS compatibility

export class CardIdentityEngine {
  static normalize(subject: any) {
    // TODO: Implement strong normalization and canonical key generation
    // For now, return a simple key and max confidence
    const canonicalKey = [
      subject.playerName?.toLowerCase() || '',
      subject.cardYear || '',
      subject.product?.toLowerCase() || '',
      subject.parallel?.toLowerCase() || '',
      subject.serialNumber || '',
      subject.gradeCompany?.toLowerCase() || '',
      subject.gradeValue || '',
      subject.isAuto ? 'auto' : '',
      subject.isPatch ? 'patch' : ''
    ].join('-');
    return { canonicalKey, matchConfidence: 100 };
  }
}
