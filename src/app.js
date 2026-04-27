console.log("[APP] app.js loaded");

const express = require("express");
const cors = require("cors");
const healthRoutes = require("./routes/healthRoutes");
const authRoutes = require("./routes/authRoutes");
const driverRoutes = require("./routes/driverRoutes");
const locationRoutes = require("./routes/locationRoutes");
const passengerRoutes = require("./routes/passengerRoutes");
const passengerAuthRoutes = require("./routes/passengerAuthRoutes");
const passengerSosRoutes = require("./routes/passengerSosRoutes");
const driverEmergencyRoutes = require("./routes/driverEmergencyRoutes");
const sosRoutes = require("./routes/sosRoutes");
const adminRoutes = require("./routes/adminRoutes");
const busTrackingRoutes = require("./routes/busTrackingRoutes");

const app = express();

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (configuredOrigins.length === 0) return callback(null, true);
      if (configuredOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin blocked"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ message: "Hybrid Bus Tracking backend running" });
});

// Root health endpoint for backward compatibility
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/driver/emergency", driverEmergencyRoutes);
app.use("/api/sos", sosRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/passenger/auth", passengerAuthRoutes);
app.use("/api/passenger/sos", passengerSosRoutes);
app.use("/api/passenger", passengerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/buses", busTrackingRoutes);

// Debug endpoint to verify latest code is running
app.get("/_health/routes", (req, res) => res.json({ ok: true, timestamp: Date.now() }));

module.exports = app;
