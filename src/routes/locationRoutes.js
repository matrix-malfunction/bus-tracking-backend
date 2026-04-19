const express = require("express");
const router = express.Router();

const {
  updateLocation,
  getAllBusLocations,
  getNearestSingleBus
} = require("../controllers/locationController");

// POST route
router.post("/update", updateLocation);

// GET routes
router.get("/all", getAllBusLocations);
router.get("/nearest-stop", getNearestSingleBus);

module.exports = router;
