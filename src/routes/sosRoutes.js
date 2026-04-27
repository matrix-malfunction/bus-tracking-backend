const express = require("express");
const { triggerSos } = require("../controllers/driverFeatureController");
const SOS = require("../models/SOS");

console.log("[ROUTE] SOS routes loaded from:", __filename);

const router = express.Router();

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
    
    const sos = await SOS.findOne({ busId, status: "active" })
      .sort({ createdAt: -1 });
    return res.json({
      active: !!sos,
      sos: sos || null
    });
  } catch (err) {
    return res.status(500).json({
      active: false,
      sos: null,
      error: "Failed to fetch SOS"
    });
  }
});

router.post("/", triggerSos);

module.exports = router;
