"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
exports.checkLearningReadiness = checkLearningReadiness;
// src/config/env.ts
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function parseEnvVar(key, fallback, required = false) {
    const val = process.env[key];
    if (val === undefined || val === "") {
        if (required && process.env.AI_MODE === "azure") {
            // Beta: suppress env var warning
        }
        return fallback;
    }
    if (typeof fallback === "number")
        return Number(val);
    if (typeof fallback === "boolean")
        return val === "true";
    return val;
}
exports.env = {
    PORT: parseEnvVar("PORT", 4000),
    NODE_ENV: parseEnvVar("NODE_ENV", "development"),
    CLIENT_APP_URL: parseEnvVar("CLIENT_APP_URL", "http://localhost:5173"),
    AI_MODE: parseEnvVar("AI_MODE", "mock"),
    AZURE_OPENAI_ENDPOINT: parseEnvVar("AZURE_OPENAI_ENDPOINT", "", true),
    AZURE_OPENAI_API_KEY: parseEnvVar("AZURE_OPENAI_API_KEY", "", true),
    AZURE_OPENAI_DEPLOYMENT: parseEnvVar("AZURE_OPENAI_DEPLOYMENT", "", true),
    AZURE_AI_SEARCH_ENDPOINT: parseEnvVar("AZURE_AI_SEARCH_ENDPOINT", "", true),
    AZURE_AI_SEARCH_API_KEY: parseEnvVar("AZURE_AI_SEARCH_API_KEY", "", true),
    AZURE_AI_SEARCH_INDEX: parseEnvVar("AZURE_AI_SEARCH_INDEX", "", true),
    AZURE_STORAGE_CONNECTION_STRING: parseEnvVar("AZURE_STORAGE_CONNECTION_STRING", "", true),
    AZURE_STORAGE_CONTAINER: parseEnvVar("AZURE_STORAGE_CONTAINER", "", true),
    REDIS_URL: parseEnvVar("REDIS_URL", "", true),
    APPLICATIONINSIGHTS_CONNECTION_STRING: parseEnvVar("APPLICATIONINSIGHTS_CONNECTION_STRING", "", true),
    ENABLE_LEARNING_JOBS: parseEnvVar("ENABLE_LEARNING_JOBS", true),
    ENABLE_AUTO_WEIGHT_UPDATES: parseEnvVar("ENABLE_AUTO_WEIGHT_UPDATES", false),
    ENABLE_PROMPT_EXPERIMENTS: parseEnvVar("ENABLE_PROMPT_EXPERIMENTS", true),
    MAX_WEEKLY_WEIGHT_CHANGE: parseEnvVar("MAX_WEEKLY_WEIGHT_CHANGE", 0.05),
    MIN_SAMPLE_SIZE_FOR_RECALIBRATION: parseEnvVar("MIN_SAMPLE_SIZE_FOR_RECALIBRATION", 25),
    DEFAULT_ALERT_COOLDOWN_MINUTES: parseEnvVar("DEFAULT_ALERT_COOLDOWN_MINUTES", 180),
};
function checkLearningReadiness() {
    if (exports.env.AI_MODE !== "azure")
        return { ready: true, mode: exports.env.AI_MODE, missing: [] };
    const required = [
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_AI_SEARCH_ENDPOINT",
        "AZURE_AI_SEARCH_API_KEY",
        "AZURE_AI_SEARCH_INDEX",
        "AZURE_STORAGE_CONNECTION_STRING",
        "AZURE_STORAGE_CONTAINER",
        "REDIS_URL",
        "APPLICATIONINSIGHTS_CONNECTION_STRING"
    ];
    const missing = required.filter(k => !process.env[k]);
    return { ready: missing.length === 0, mode: exports.env.AI_MODE, missing };
}
