import cors from "cors";
// CORS configuration
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : ["*"];
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
import 'module-alias/register';
import express from "express";


import compiqRouter from "./routes/compiq";
import playeriqRouter from "./routes/playeriq";
import dailyiqRouter from "./routes/dailyiq";
import portfolioiqRouter from "./routes/portfolioiq";
import intakeRouter from "./routes/intake";
import adminRouter from "./api/admin/admin.routes";
import diagnosticsRouter from "./api/diagnostics/diagnostics.routes";

const app = express();
app.use(express.json());



app.use("/api/compiq", compiqRouter);
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

app.get("/", (req, res) => {
  res.send("HobbyIQ API is running");
});

const port = process.env.PORT || 3001;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`API running on ${host}:${port}`);
});
