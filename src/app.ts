import cors from "cors";
import express from "express";

import compIQRoutes from "./routes/compiq";
import dailyIQRoutes from "./routes/dailyiq";
import healthRoutes from "./routes/health";
import playerIQRoutes from "./routes/playeriq";
import portfolioIQRoutes from "./routes/portfolioiq";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";

export const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/health", healthRoutes);
app.use("/api/compiq", compIQRoutes);
app.use("/api/playeriq", playerIQRoutes);
app.use("/api/dailyiq", dailyIQRoutes);
app.use("/api/portfolioiq", portfolioIQRoutes);

app.use(notFound);
app.use(errorHandler);
