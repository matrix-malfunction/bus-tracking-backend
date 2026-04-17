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

const app = express();

// CORS configuration - allow all origins for Render deployment
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ message: "Hybrid Bus Tracking backend running" });
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

module.exports = app;
