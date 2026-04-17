const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const app = require("./app");
const locationRoutes = require("./routes/locationRoutes");
const { connectDB } = require("./config/db");
const { registerSocketHandlers } = require("./sockets");

dotenv.config();
app.use("/location", locationRoutes);

const server = http.createServer(app);
const port = Number(process.env.PORT) || 5000;

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.set("io", io);
registerSocketHandlers(io);
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);
});

async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    server.listen(port, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${port}`);
      console.log(`📡 API available at http://0.0.0.0:${port}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
});

startServer();
