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

// Route-level logging middleware to diagnose 403 issues
const routeLogger = (req, res, next) => {
  console.log(`[ROUTE] ${req.method} ${req.path} - HIT`);
  console.log(`[ROUTE] Headers:`, JSON.stringify(req.headers, null, 2));
  next();
};

// POST routes with logging
router.post("/update", routeLogger, updateLocation);
router.post("/start", startTracking);
router.post("/stop", stopTracking);

// GET routes
router.get("/all", getAllBusLocations);
router.get("/nearest-stop", getNearestStopHandler);
router.get("/nearest-single", getNearestSingleBus);

module.exports = router;
