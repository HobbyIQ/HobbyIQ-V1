import express from "express";
import healthRouter from "./routes/health";
import compiqRouter from "./routes/compiq";

const app = express();

// Request logger
app.use((req, res, next) => {
	console.log(`${req.method} ${req.url}`);
	next();
});

app.use(express.json());

app.use("/api", healthRouter);
app.use("/api/compiq", compiqRouter);

export default app;
