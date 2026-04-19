const express = require("express");
const mongoose = require("mongoose");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const Location = require("../models/Location");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const { sendPassengerSos } = require("../controllers/passengerFeatureController");

const router = express.Router();

router.get("/nearby-buses", requireAuth, requireRole("passenger"), async (req, res) => {
  try {
    const buses = await Location.find()
      .select("busId latitude longitude timestamp -_id")
      .sort({ timestamp: -1 })
      .lean();

    return res.status(200).json({
      message: "Nearby buses fetched successfully",
      role: req.user.role,
      userId: req.user.id,
      buses,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch nearby buses" });
  }
});

router.get("/routes", requireAuth, requireRole("passenger"), async (req, res) => {
  try {
    const routes = await Route.find().select("name").lean();
    return res.status(200).json({
      count: routes.length,
      routes: routes.map((route) => ({
        routeId: route._id,
        name: route.name,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch routes" });
  }
});

router.get("/routes/:routeId/schedule", requireAuth, requireRole("passenger"), async (req, res) => {
  try {
    const { routeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(routeId)) {
      return res.status(400).json({ message: "routeId must be a valid ObjectId" });
    }

    const [route, stops, schedule] = await Promise.all([
      Route.findById(routeId).select("name stops schedule").lean(),
      Stop.find({ routeId }).sort({ order: 1 }).lean(),
      Schedule.findOne({ routeId }).lean(),
    ]);

    if (!route) {
      return res.status(404).json({ message: "Route not found" });
    }

    const scheduleByStopId = new Map(
      (schedule?.stops || []).map((entry) => [String(entry.stopId), entry.time || ""])
    );

    let normalizedStops = stops.map((stop) => ({
      stopId: stop._id,
      name: stop.name,
      latitude: stop.latitude,
      longitude: stop.longitude,
      order: stop.order,
      time: scheduleByStopId.get(String(stop._id)) || "",
    }));

    if (normalizedStops.length === 0) {
      normalizedStops = (route.stops || []).map((stop, index) => ({
        stopId: null,
        name: stop.name || `Stop ${index + 1}`,
        latitude: stop.latitude ?? stop.lat,
        longitude: stop.longitude ?? stop.lng,
        order: index,
        time: route.schedule?.[index]?.time || "",
      }));
    }

    return res.status(200).json({
      routeId: route._id,
      routeName: route.name,
      stops: normalizedStops,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch route schedule" });
  }
});

router.post("/sos", requireAuth, sendPassengerSos);

module.exports = router;
