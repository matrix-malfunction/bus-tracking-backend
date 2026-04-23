const express = require("express");
const router = express.Router();

const {
  updateLocation,
  getAllBusLocations,
  getNearestSingleBus,
} = require("../controllers/locationController");

/**
 * Location Routes (Updated for merged backend)
 *
 * POST /api/location/update - Driver updates location (KEEP)
 * GET /api/location/all - Get all buses (REDIRECTED to use Bus model)
 * GET /api/location/nearest-stop - Get nearest stop (KEEP)
 */

// POST route - Driver updates location
// This is used by driver-app to report position
router.post("/update", updateLocation);

// GET /all - Get all bus locations
// DEPRECATED: Use /api/buses or /api/buses/nearby instead
// This endpoint now uses the new Bus model for consistency
router.get("/all", getAllBusLocations);

// GET /nearest-stop - Find nearest bus stop
router.get("/nearest-stop", getNearestSingleBus);

/**
 * Redirect helper for migration
 * Clients can be gradually moved from /api/location/all to /api/buses
 */
router.get("/redirect-test", (req, res) => {
  res.json({
    message: "This endpoint demonstrates the redirect pattern",
    oldEndpoint: "/api/location/all",
    newEndpoint: "/api/buses?compact=true",
    migrationGuide: "Update your client to use /api/buses instead",
  });
});

module.exports = router;
