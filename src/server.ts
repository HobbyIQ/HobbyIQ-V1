import { app } from "./app";
import compIQRoutes from "./routes/compiq";
import dailyIQRoutes from "./routes/dailyiq";
import healthRoutes from "./routes/health";
import playerIQRoutes from "./routes/playeriq";
import portfolioIQRoutes from "./routes/portfolioiq";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";
import { env } from "./config/env";
import { logger } from "./utils/logger";

app.use("/api/health", healthRoutes);
app.use("/api/compiq", compIQRoutes);
app.use("/api/playeriq", playerIQRoutes);
app.use("/api/dailyiq", dailyIQRoutes);
app.use("/api/portfolio", portfolioIQRoutes);
app.use("/api/portfolioiq", portfolioIQRoutes);

app.use(notFound);
app.use(errorHandler);

const configuredPort = process.env.PORT;
const port = configuredPort ? Number(configuredPort) : env.PORT;
const listenPort = Number.isFinite(port) ? port : env.PORT;

app.listen(listenPort, () => {
    logger.info("HobbyIQ API started", {
        port: listenPort,
        environment: env.NODE_ENV,
        mockMode: env.USE_MOCK_DATA,
    });
});
