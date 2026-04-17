const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const { updateLocation } = require("../controllers/locationController");
const { setRoute } = require("../controllers/driverController");
const { reportDriverEmergency } = require("../controllers/driverFeatureController");

const router = express.Router();

const normalizeDriverLocationPayload = (req, res, next) => {
  req.body = {
    ...req.body,
    busId: (req.body?.busId || "").trim(),
    source: req.body?.source || "mobile",
    lat: req.body?.lat ?? req.body?.latitude,
    lng: req.body?.lng ?? req.body?.longitude,
  };
  next();
};

router.post("/location", requireAuth, requireRole("driver"), normalizeDriverLocationPayload, updateLocation);
router.post("/set-route", requireAuth, requireRole("driver"), setRoute);
router.post("/emergency", requireAuth, requireRole("driver"), reportDriverEmergency);

module.exports = router;
