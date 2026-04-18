
import 'module-alias/register';
import express from "express";
import cors from "cors";
// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : ["*"];

const app = express();
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));


import compiqRouter from "./routes/compiq";
import playeriqRouter from "./routes/playeriq";
import dailyiqRouter from "./routes/dailyiq";
import portfolioiqRouter from "./routes/portfolioiq";
import intakeRouter from "./routes/intake";
import adminRouter from "./api/admin/admin.routes";
import diagnosticsRouter from "./api/diagnostics/diagnostics.routes";


app.use(express.json());



app.use("/api/compiq", compiqRouter);
// Alias: /api/pricing -> /api/compiq
app.use("/api/pricing", compiqRouter);
app.use("/api/playeriq", playeriqRouter);
app.use("/api/dailyiq", dailyiqRouter);
app.use("/api/portfolioiq", portfolioiqRouter);
app.use("/api/intake", intakeRouter);

// Admin/diagnostics endpoints (internal only)
app.use("/api/admin", adminRouter);
app.use("/api/diagnostics", diagnosticsRouter);


// Basic error handler
import type { ErrorRequestHandler } from "express";
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
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
