const express = require("express");
const { triggerSos } = require("../controllers/driverFeatureController");
const DriverEmergency = require("../models/DriverEmergency");

console.log("[ROUTE] SOS routes loaded from:", __filename);

const router = express.Router();

// TTL for SOS auto-expiry (5 minutes)
const FIVE_MINUTES = 5 * 60 * 1000;

// GET /api/sos/status - Safe endpoint for driver SOS checks
router.get("/status", async (req, res) => {
  try {
    const { busId } = req.query;
    
    // Validate input
    if (!busId) {
      return res.status(400).json({
        active: false,
        sos: null,
        error: "busId required"
      });
    }
    
    // Filter active SOS at DB level with TTL (activity-based, prevent stale/ghost SOS)
    const sos = await DriverEmergency.findOne({
      busId,
      $or: [
        { status: { $in: ["active", "sos", "SOS"] } },
        { type: "emergency" }
      ],
      lastUpdate: { $gte: new Date(Date.now() - FIVE_MINUTES) }
    }).sort({ lastUpdate: -1 });

    let isActive = false;

    if (sos) {
      const status = String(sos.status || "").toLowerCase();
      const type = String(sos.type || "").toLowerCase();

      isActive =
        status === "active" ||
        status === "sos" ||
        type === "emergency";
    }

    return res.json({
      active: isActive,
      sos: isActive ? sos : null
    });
  } catch (err) {
    console.error("[SOS STATUS ERROR]", err.message);
    return res.status(500).json({
      active: false,
      sos: null,
      error: "Failed to fetch SOS"
    });
  }
});

router.post("/", triggerSos);

module.exports = router;
