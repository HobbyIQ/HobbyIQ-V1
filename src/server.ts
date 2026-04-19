
import express, { Request, Response } from "express";
import cors from "cors";

import compiqRouter from "./api/routes/compiq";
import playeriqRouter from "./api/routes/playeriq";
import brainRouter from "./api/routes/brain";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "HobbyIQ running" });
});

app.use("/api/compiq", compiqRouter);
app.use("/api/playeriq", playeriqRouter);
app.use("/api/brain", brainRouter);

const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`HobbyIQ running on port ${port}`);
});
