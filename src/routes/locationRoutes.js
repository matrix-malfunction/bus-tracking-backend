const express = require("express");
const router = express.Router();

const {
  updateLocation,
  getAllBusLocations,
  getNearestStopHandler,
  getNearestSingleBus
} = require("../controllers/locationController");

// POST route
router.post("/update", updateLocation);

// GET routes
router.get("/all", getAllBusLocations);
router.get("/nearest-stop", getNearestStopHandler);
router.get("/nearest-single", getNearestSingleBus);

module.exports = router;
