"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const compiq_1 = __importDefault(require("./api/routes/compiq"));
const playeriq_1 = __importDefault(require("./api/routes/playeriq"));
const brain_1 = __importDefault(require("./api/routes/brain"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get("/api/health", (req, res) => {
    res.json({ status: "HobbyIQ running" });
});
app.use("/api/compiq", compiq_1.default);
app.use("/api/playeriq", playeriq_1.default);
app.use("/api/brain", brain_1.default);
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
    console.log(`HobbyIQ running on port ${port}`);
});
