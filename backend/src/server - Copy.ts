import app from "./app.js";
import { getConfig } from "./config/env.js";

const config = getConfig();
const port = Number(process.env.PORT || config.PORT || 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`HobbyIQ API listening on port ${port}`);
});
