const express = require("express");
const app = express();

const PORT = process.env.PORT || 8080;

// TEMP: basic health route
app.get("/", (req, res) => {
  res.send("HobbyIQ backend is LIVE 🚀");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
