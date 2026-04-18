"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FallbackPolicyService = void 0;
class FallbackPolicyService {
    static getFallback(reason) {
        switch (reason) {
            case 'provider_unavailable':
                return { serve: 'stale', confidence: 'low', message: 'Provider unavailable, serving stale data.' };
            case 'snapshot_stale':
                return { serve: 'stale', confidence: 'medium', message: 'Snapshot stale but usable.' };
            case 'partial_config':
                return { serve: 'limited', confidence: 'low', message: 'Provider partially configured.' };
            default:
                return { serve: 'none', confidence: 'none', message: 'No fallback available.' };
        }
    }
}
exports.FallbackPolicyService = FallbackPolicyService;
