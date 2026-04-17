const express = require("express");
const router = express.Router();

const {
  updateLocation,
  getAllBusLocations,
  getNearestStop
} = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");

// POST route - public (no auth required for driver updates)
router.post("/update", updateLocation);

// GET routes
router.get("/all", getAllBusLocations);
router.get("/nearest-stop", requireAuth, getNearestStop);

module.exports = router;
