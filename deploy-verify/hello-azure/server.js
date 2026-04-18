const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Hello from Azure Node.js!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hello World app listening on port ${PORT}`);
});
