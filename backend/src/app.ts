import express from "express";
import cors from "cors";
import { getConfig } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRoutes from "./routes/health.routes.js";
import compiqRoutes from "./routes/compiq.routes.js";
import portfolioiqRoutes from "./routes/portfolioiq.routes.js";
import dailyiqRoutes from "./routes/dailyiq.routes.js";
import playeriqRoutes from "./routes/playeriq.routes.js";
import authRoutes from "./routes/auth.routes.js";

const config = getConfig();
const app = express();

app.use(express.json());
app.use(cors({
  origin: config.CORS_ALLOWED_ORIGINS || "*",
}));
app.use(requestLogger);

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/compiq", compiqRoutes);
app.use("/api/portfolioiq", portfolioiqRoutes);
app.use("/api/dailyiq", dailyiqRoutes);
app.use("/api/playeriq", playeriqRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
