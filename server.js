const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.end("Bot is running");
}).listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

require("./index.js");