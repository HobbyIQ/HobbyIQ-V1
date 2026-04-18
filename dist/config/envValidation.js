"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envSchema = void 0;
exports.validateEnv = validateEnv;
const zod_1 = require("zod");
exports.envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.string().optional(),
    PORT: zod_1.z.string().optional(),
    AZURE_STORAGE_CONNECTION_STRING: zod_1.z.string().optional(),
});
function validateEnv(env) {
    const result = exports.envSchema.safeParse(env);
    if (!result.success) {
        throw new Error('Invalid environment configuration: ' + JSON.stringify(result.error.issues));
    }
}
