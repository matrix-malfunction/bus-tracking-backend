const mongoose = require("mongoose");

function getHealth(req, res) {
  const dbStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    database: dbStateMap[mongoose.connection.readyState] || "unknown",
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  getHealth,
};
