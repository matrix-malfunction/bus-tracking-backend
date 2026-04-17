const express = require("express");
const mongoose = require("mongoose");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const Location = require("../models/Location");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const { sendPassengerSos } = require("../controllers/passengerFeatureController");

const router = express.Router();

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isValidCoordinate(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function isFresh(doc, nowMs = Date.now()) {
  const timestamp = doc?.updatedAt || doc?.timestamp;
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowMs - ts <= ACTIVE_WINDOW_MS;
}

router.get("/nearby-buses", requireAuth, requireRole("passenger"), async (req, res) => {
  try {
    const nowMs = Date.now();

    const allLocations = await Location.find()
      .select("busId latitude longitude lat lng source updatedAt timestamp -_id")
      .sort({ updatedAt: -1, timestamp: -1 })
      .lean();

    // Filter out stale and invalid data
    const validBuses = allLocations
      .filter((loc) => {
        // Check freshness
        if (!isFresh(loc, nowMs)) return false;

        // Validate coordinates (handle both lat/lng and latitude/longitude field names)
        const lat = loc.latitude ?? loc.lat;
        const lng = loc.longitude ?? loc.lng;
        return isValidCoordinate(lat, lng);
      })
      .map((loc) => ({
        busId: loc.busId,
        latitude: loc.latitude ?? loc.lat,
        longitude: loc.longitude ?? loc.lng,
        source: loc.source || "unknown",
        timestamp: loc.updatedAt || loc.timestamp,
      }));

    console.log("📍 nearby-buses:", {
      totalInDb: allLocations.length,
      validBuses: validBuses.length,
      requestedBy: req.user?.id,
    });

    return res.status(200).json({
      message: "Nearby buses fetched successfully",
      role: req.user.role,
      userId: req.user.id,
      buses: validBuses,
    });
  } catch (error) {
    console.error("❌ Failed to fetch nearby buses:", error.message);
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
