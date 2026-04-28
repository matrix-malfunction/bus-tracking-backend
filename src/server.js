console.log("[SERVER] server.js started");

const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const app = require("./app");
const locationRoutes = require("./routes/locationRoutes");
const { connectDB } = require("./config/db");
const { registerSocketHandlers } = require("./sockets");
const Bus = require("./models/Bus");
const { cleanupStaleState } = require("./utils/trackingState");

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
    await connectDB(process.env.MONGODB_URI);

    // Start stale bus cleanup scheduler
    setInterval(async () => {
      try {
        await Bus.markStaleBusesInactive();
      } catch (err) {
        console.error("[BACKEND] Stale cleanup failed:", err.message);
      }
    }, 60000);
    console.log("[BACKEND] Stale bus cleanup scheduler started (60s interval)");

    // Start tracking state TTL cleanup (15s interval) - removes ghost buses
    setInterval(() => {
      try {
        const cleaned = cleanupStaleState(io);
        if (cleaned.length > 0) {
          console.log("[BACKEND] TTL cleanup - removed buses:", cleaned);
        }
      } catch (err) {
        console.error("[BACKEND] TTL cleanup failed:", err.message);
      }
    }, 15000);
    console.log("[BACKEND] Tracking state TTL cleanup started (15s interval)");

    server.listen(port, "0.0.0.0", () => {
      console.log(`Server listening on port ${port}`);
      console.log(`Server running on http://0.0.0.0:${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
});

startServer();
