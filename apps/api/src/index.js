"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("module-alias/register");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : ["*"];
const app = (0, express_1.default)();
app.use((0, cors_1.default)({
    origin: allowedOrigins,
    credentials: true
}));
const compiq_1 = __importDefault(require("./routes/compiq"));
const playeriq_1 = __importDefault(require("./routes/playeriq"));
const dailyiq_1 = __importDefault(require("./routes/dailyiq"));
const portfolioiq_1 = __importDefault(require("./routes/portfolioiq"));
const intake_1 = __importDefault(require("./routes/intake"));
const admin_routes_1 = __importDefault(require("./api/admin/admin.routes"));
const diagnostics_routes_1 = __importDefault(require("./api/diagnostics/diagnostics.routes"));
app.use(express_1.default.json());
app.use("/api/compiq", compiq_1.default);
// Alias: /api/pricing -> /api/compiq
app.use("/api/pricing", compiq_1.default);
app.use("/api/playeriq", playeriq_1.default);
app.use("/api/dailyiq", dailyiq_1.default);
app.use("/api/portfolioiq", portfolioiq_1.default);
app.use("/api/intake", intake_1.default);
// Admin/diagnostics endpoints (internal only)
app.use("/api/admin", admin_routes_1.default);
app.use("/api/diagnostics", diagnostics_routes_1.default);
const errorHandler = (err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);
// Azure/production health check endpoint
app.get("/api/health", (_req, res) => {
    res.json({ status: "HobbyIQ running" });
});
app.get("/", (req, res) => {
    res.send("HobbyIQ API is running");
});
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on 0.0.0.0:${PORT}`);
});
console.log("=== HobbyIQ API starting up ===");
