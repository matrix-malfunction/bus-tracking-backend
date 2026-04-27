const express = require("express");
const router = express.Router();

const {
  updateLocation,
  getAllBusLocations,
  getNearestStopHandler,
  getNearestSingleBus,
  startTracking,
  stopTracking
} = require("../controllers/locationController");

// POST routes
router.post("/update", updateLocation);
router.post("/start", startTracking);
router.post("/stop", stopTracking);

// GET routes
router.get("/all", getAllBusLocations);
router.get("/nearest-stop", getNearestStopHandler);
router.get("/nearest-single", getNearestSingleBus);

module.exports = router;
