const express = require("express");
const cors = require("cors");
const compression = require("compression");
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
// NEW: Bus tracking routes from bus-tracker-backend
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

// NEW: Compression middleware from bus-tracker-backend
app.use(
  compression({
    level: 6,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  })
);

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Bus Tracking API (Merged)",
    version: "2.0.0",
    endpoints: {
      // Original endpoints
      driver: "/api/driver/*",
      passenger: "/api/passenger/*",
      admin: "/api/admin/*",
      // New geospatial endpoints
      buses: "/api/buses/*",
      nearby: "/api/buses/nearby",
      bounds: "/api/buses/bounds",
      stream: "/api/buses/stream",
    },
    deprecated: ["/api/location/all (use /api/buses)"],
  });
});

// Root health endpoint for backward compatibility
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  });
});

// Original routes (maintain for backward compatibility)
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/driver/emergency", driverEmergencyRoutes);
app.use("/api/sos", sosRoutes);
// DEPRECATED: locationRoutes - will redirect to new endpoints
app.use("/api/location", locationRoutes);
app.use("/api/passenger/auth", passengerAuthRoutes);
app.use("/api/passenger/sos", passengerSosRoutes);
app.use("/api/passenger", passengerRoutes);
app.use("/api/admin", adminRoutes);

// NEW: Bus tracking routes (from bus-tracker-backend)
// These provide geospatial queries and real-time streaming
app.use("/api/buses", busTrackingRoutes);

// Deprecation notice middleware for old endpoints
app.use("/api/location/all", (req, res, next) => {
  res.setHeader("X-Deprecated", "true");
  res.setHeader("X-Alternative", "/api/buses or /api/buses/nearby");
  next();
});

module.exports = app;
