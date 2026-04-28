const Bus = require("../models/Bus");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const DriverEmergency = require("../models/DriverEmergency");
const { isTrackingActive, setTrackingActive, getTrackingState, trackingState } = require("../utils/trackingState");

const { chooseBestSource } = require("../services/hybridSourceSelector");
const { haversineKm } = require("../services/etaService");
const { defaultCache } = require("../services/locationCache");

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const EMIT_DISTANCE_THRESHOLD_METERS = 15;
const MIN_SPEED_KMPH = 10;
const DEFAULT_SPEED_KMPH = 30;
const MAX_SPEED_KMPH = 80;
const STOP_THRESHOLD_METERS = 15;
const MIN_TIME_DIFF_SEC = 3;
const JITTER_THRESHOLD_METERS = 8;

function logInfo(event, data = {}) {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...data,
    })
  );
}

function getTime(doc) {
  return new Date(doc?.updatedAt || doc?.timestamp || 0);
}

function isStale(doc, nowMs = Date.now()) {
  const t = getTime(doc);
  const stamp = t.getTime();
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return nowMs - stamp > ACTIVE_WINDOW_MS;
}

function clampEtaMinutes(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function cumulativeDistanceKm(stops, fromIndex, toIndex) {
  if (!Array.isArray(stops) || !stops.length) return 0;
  if (toIndex <= fromIndex) return 0;
  let total = 0;
  for (let i = fromIndex; i < toIndex; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (!a || !b) continue;
    total += haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
  }
  return total;
}

function findNearestStopIndex(stops, point) {
  if (!Array.isArray(stops) || !stops.length) return -1;
  let minDistance = Infinity;
  let minIndex = -1;
  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const distance = haversineKm(point.latitude, point.longitude, stop.latitude, stop.longitude);
    if (Number.isFinite(distance) && distance < minDistance) {
      minDistance = distance;
      minIndex = i;
    }
  }
  return minIndex;
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function getNextStop(busLat, busLng, route) {
  if (!route || !Array.isArray(route.stops) || route.stops.length === 0) {
    return { stop: null, distance: Infinity };
  }

  let nextStop = null;
  let minDist = Infinity;

  for (const stop of route.stops) {
    const dist = getDistance(busLat, busLng, stop.lat, stop.lng);

    if (dist < minDist) {
      minDist = dist;
      nextStop = stop;
    }
  }

  return { stop: nextStop, distance: minDist };
}

async function updateLocation(req, res) {
  // Log immediately upon entry - confirms controller is reached
  console.log("[BACKEND] ========== LOCATION UPDATE ==========");
  console.log("[BACKEND] req.body:", JSON.stringify(req.body, null, 2));
  console.log("[BACKEND] req.path:", req.path);
  console.log("[BACKEND] req.method:", req.method);
  
  try {
    const io = req.app.get("io");
    console.log("[BACKEND] io exists:", !!io);
    
    const { busId, source } = req.body;
    const lat = req.body.lat ?? req.body.latitude;
    const lng = req.body.lng ?? req.body.longitude;
    
    console.log("[BACKEND] Parsed values:", { busId, lat, lng, source });
    
    // === INPUT VALIDATION ===
    const missingFields = [];
    if (!busId) missingFields.push("busId");
    if (lat == null) missingFields.push("latitude/lat");
    if (lng == null) missingFields.push("longitude/lng");
    
    if (missingFields.length > 0) {
      console.log("[BACKEND] ❌ MISSING FIELDS:", missingFields);
      return res.status(400).json({ 
        error: "Missing required fields", 
        missing: missingFields,
        received: Object.keys(req.body)
      });
    }
    
    // === TRACKING STATE AUTO-INIT ===
    let state = trackingState.get(busId);
    console.log("[BACKEND] trackingState exists:", !!state);
    
    if (!state) {
      console.log("[BACKEND] Auto-initializing tracking state for:", busId);
      state = {
        trackingActive: true,
        sos: false,
        lastUpdate: Date.now(),
        location: null
      };
      trackingState.set(busId, state);
    }
    
    // Block only if explicitly stopped
    if (state?.trackingActive === false) {
      console.log("[BACKEND] ❌ BLOCKED - tracking stopped:", busId);
      return res.status(403).json({ error: "Tracking not active" });
    }
    
    // === STRICT VALIDATION ===
    const numLat = Number(lat);
    const numLng = Number(lng);
    
    if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
      console.log("[BACKEND] ❌ Invalid lat/lng:", { lat, lng, numLat, numLng });
      return res.status(400).json({ error: "Invalid lat/lng values" });
    }
    
    if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
      console.log("[BACKEND] ❌ Out of range lat/lng:", { numLat, numLng });
      return res.status(400).json({ error: "Lat/lng out of valid range" });
    }
    
    // === UPDATE DATABASE ===
    const updated = await Bus.findOneAndUpdate(
      { busId: busId.trim() },
      {
        $set: {
          busId: busId.trim(),
          location: {
            type: "Point",
            coordinates: [numLng, numLat],
          },
          lat: numLat,
          lng: numLng,
          speed: req.body.speed || 0,
          heading: req.body.heading || 0,
          status: "active",
          lastUpdate: new Date(),
        },
      },
      { upsert: true, new: true }
    );
    
    console.log("[BACKEND] ✅ Saved to DB:", {
      busId: updated.busId,
      lat: numLat,
      lng: numLng
    });
    
    // === SOCKET EMIT ===
    if (io && busId && Number.isFinite(numLat) && Number.isFinite(numLng)) {
      const emitPayload = {
        busId: busId.trim(),
        latitude: numLat,
        longitude: numLng,
      };
      console.log("[BACKEND] 📡 Emitting BUS_LOCATION_UPDATE:", emitPayload);
      
      io.emit("BUS_LOCATION_UPDATE", emitPayload);
      console.log("[BACKEND] ✅ Socket event emitted");
    } else {
      console.log("[BACKEND] ⚠️ Socket emit skipped - invalid data");
    }
    
    // === UPDATE TRACKING STATE ===
    if (state && busId) {
      trackingState.set(busId, {
        ...state,
        lastUpdate: Date.now(),
        location: { latitude: numLat, longitude: numLng }
      });
      console.log("[BACKEND] ✅ State updated with location for:", busId);
    }
    
    return res.json({ 
      success: true, 
      data: updated,
      timestamp: Date.now()
    });
    
  } catch (err) {
    console.error("🔥 BACKEND ERROR ==========");
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);
    console.error("Request body:", req.body);
    console.error("==========================");
    
    res.status(500).json({ 
      error: "Server error", 
      message: err.message,
      requestId: Date.now().toString(36)
    });
  }
};

async function getNearestStopHandler(req, res) {
  try {
    const nowMs = Date.now();
    const userLat = Number(req.query.lat);
    const userLng = Number(req.query.lng);
    const hasUserLocation = Number.isFinite(userLat) && Number.isFinite(userLng);
    const routeFilter = req.query.routeId ? String(req.query.routeId) : null;

    defaultCache.deleteStale(ACTIVE_WINDOW_MS);
    const normalizeBus = (item) => {
      const latitude = Number(item?.latitude ?? item?.lat);
      const longitude = Number(item?.longitude ?? item?.lng);
      const valid = Number.isFinite(latitude) && Number.isFinite(longitude);
      if (!valid) return null;
      return {
        busId: item.busId,
        latitude,
        longitude,
        speed: Number(item.speed) || 0,
        routeId: item.routeId || null,
        updatedAt: item.updatedAt || item.timestamp || null,
        timestamp: item.timestamp || item.updatedAt || null,
        name: item.name || item.busId,
      };
    };

    const cacheCandidates = defaultCache.getAll().map(normalizeBus).filter(Boolean);
    const cacheFiltered = cacheCandidates.filter((bus) => !isStale(bus, nowMs));
    let buses = cacheFiltered;
    let dbCount = 0;
    let filteredCount = cacheFiltered.length;

    if (cacheCandidates.length === 0 || buses.length === 0) {
      const dbCandidatesRaw = await Bus.find({ status: "active" })
        .sort({ lastUpdate: -1 })
        .limit(50)
        .select("busId lat lng speed heading status lastUpdate")
        .lean();
      dbCount = dbCandidatesRaw.length;

      const dbCandidates = dbCandidatesRaw.map(normalizeBus).filter(Boolean);
      const dbFiltered = dbCandidates.filter((bus) => !isStale(bus, nowMs));

      // Reliability-first: if stale filter empties the set but DB has valid rows, return valid rows.
      buses = dbFiltered.length > 0 ? dbFiltered : dbCandidates;
      filteredCount = buses.length;

      for (const bus of buses) {
        defaultCache.set(bus.busId, bus);
      }
    }

    if (buses.length > 0) {
      const routeMissingBusIds = buses.filter((bus) => !bus.routeId).map((bus) => bus.busId);
      if (routeMissingBusIds.length > 0) {
        const busRouteMappings = await Bus.find({ busId: { $in: routeMissingBusIds } })
          .select("busId routeId")
          .lean();
        const routeMap = new Map(busRouteMappings.map((item) => [item.busId, item.routeId]));
        buses = buses.map((bus) => ({
          ...bus,
          routeId: bus.routeId || routeMap.get(bus.busId) || null,
        }));
      }
    }

    if (routeFilter) {
      buses = buses.filter((bus) => String(bus.routeId || "") === routeFilter);
    }

    const routeIds = Array.from(
      new Set(buses.map((bus) => String(bus.routeId || "")).filter(Boolean))
    );
    const [stopDocs, fallbackRoutes, schedules] = await Promise.all([
      routeIds.length
        ? Stop.find({ routeId: { $in: routeIds } })
            .sort({ routeId: 1, order: 1 })
            .lean()
        : [],
      routeIds.length ? Route.find({ _id: { $in: routeIds } }).lean() : [],
      routeIds.length ? Schedule.find({ routeId: { $in: routeIds } }).lean() : [],
    ]);

    const stopsByRoute = new Map();
    for (const stop of stopDocs) {
      const key = String(stop.routeId);
      if (!stopsByRoute.has(key)) stopsByRoute.set(key, []);
      stopsByRoute.get(key).push({
        _id: stop._id,
        name: stop.name,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        order: Number(stop.order) || 0,
      });
    }

    for (const route of fallbackRoutes) {
      const key = String(route._id);
      if (stopsByRoute.has(key) && stopsByRoute.get(key).length > 0) continue;
      const normalizedStops = (route.stops || [])
        .map((stop, index) => ({
          _id: null,
          name: stop.name || `Stop ${index + 1}`,
          latitude: Number(stop.latitude ?? stop.lat),
          longitude: Number(stop.longitude ?? stop.lng),
          order: index,
        }))
        .filter((stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude));
      stopsByRoute.set(key, normalizedStops);
    }

    const scheduleByRoute = new Map();
    for (const schedule of schedules) {
      const key = String(schedule.routeId);
      const timeByStopId = new Map();
      for (const entry of schedule.stops || []) {
        if (entry.stopId) {
          timeByStopId.set(String(entry.stopId), entry.time || "");
        }
      }
      scheduleByRoute.set(key, timeByStopId);
    }

    const enrichedBuses = buses
      .map((bus) => {
        const speed = Number(bus.speed) || 0;
        const effectiveSpeed = speed > 10 ? speed : 25;
        const routeKey = String(bus.routeId || "");
        const routeStops = routeKey ? stopsByRoute.get(routeKey) || [] : [];
        const routeSchedule = routeKey ? scheduleByRoute.get(routeKey) || new Map() : new Map();

        let distanceKm = hasUserLocation
          ? haversineKm(bus.latitude, bus.longitude, userLat, userLng)
          : null;
        let etaMinutes = null;
        let nextStop = null;
        let upcomingStops = [];

        if (routeStops.length > 0) {
          const busStopIndex = findNearestStopIndex(routeStops, {
            latitude: bus.latitude,
            longitude: bus.longitude,
          });
          const nextStopIndex = busStopIndex >= 0 ? Math.min(busStopIndex + 1, routeStops.length - 1) : -1;
          const nextStopData = nextStopIndex >= 0 ? routeStops[nextStopIndex] : null;
          if (nextStopData) {
            nextStop = {
              name: nextStopData.name,
              order: nextStopData.order,
              latitude: nextStopData.latitude,
              longitude: nextStopData.longitude,
              scheduledTime: nextStopData._id ? routeSchedule.get(String(nextStopData._id)) || null : null,
            };
          }

          if (hasUserLocation && busStopIndex >= 0) {
            const userStopIndex = findNearestStopIndex(routeStops, {
              latitude: userLat,
              longitude: userLng,
            });
            const targetIndex = Math.max(busStopIndex, userStopIndex);
            const busToCurrentStopKm = haversineKm(
              bus.latitude,
              bus.longitude,
              routeStops[busStopIndex].latitude,
              routeStops[busStopIndex].longitude
            );
            const routeLegKm =
              busToCurrentStopKm + cumulativeDistanceKm(routeStops, busStopIndex, targetIndex);
            const userTailKm = haversineKm(
              routeStops[targetIndex].latitude,
              routeStops[targetIndex].longitude,
              userLat,
              userLng
            );
            const cumulativeKm = routeLegKm + userTailKm;
            if (Number.isFinite(cumulativeKm)) {
              distanceKm = cumulativeKm;
              etaMinutes = clampEtaMinutes((cumulativeKm / effectiveSpeed) * 60);
            }
          }

          if (busStopIndex >= 0) {
            for (
              let i = busStopIndex;
              i < routeStops.length && upcomingStops.length < 3;
              i += 1
            ) {
              const stop = routeStops[i];
              const busToCurrentStopKm = haversineKm(
                bus.latitude,
                bus.longitude,
                routeStops[busStopIndex].latitude,
                routeStops[busStopIndex].longitude
              );
              const cumulativeKm = busToCurrentStopKm + cumulativeDistanceKm(routeStops, busStopIndex, i);
              upcomingStops.push({
                name: stop.name,
                order: stop.order,
                latitude: stop.latitude,
                longitude: stop.longitude,
                scheduledTime: stop._id ? routeSchedule.get(String(stop._id)) || null : null,
                etaMinutes: hasUserLocation ? clampEtaMinutes((cumulativeKm / effectiveSpeed) * 60) : null,
              });
            }
          }
        } else if (hasUserLocation && Number.isFinite(distanceKm)) {
          etaMinutes = clampEtaMinutes((distanceKm / effectiveSpeed) * 60);
        }

        let status = "On the way";
        if (Number.isFinite(distanceKm)) {
          if (distanceKm < 0.05) {
            status = "Arrived";
          } else if (distanceKm < 0.2) {
            status = "Arriving";
          }
        }

        return {
          busId: bus.busId,
          latitude: bus.latitude,
          longitude: bus.longitude,
          routeId: bus.routeId ? String(bus.routeId) : null,
          updatedAt: getTime(bus).toISOString(),
          name: bus.name || bus.busId,
          speed: Number.isFinite(speed) ? Math.round(speed * 100) / 100 : 0,
          distanceKm: Number.isFinite(distanceKm) ? Math.round(distanceKm * 1000) / 1000 : null,
          etaMinutes,
          status,
          nextStop,
          upcomingStops,
          isLive: true,
        };
      })
      .sort((a, b) => getTime(b).getTime() - getTime(a).getTime());

    logInfo("passenger.nearest_stop.response", {
      dbCount,
      filteredCount,
      count: enrichedBuses.length,
      routeFilter,
      hasUserLocation,
    });

    return res.status(200).json({
      count: enrichedBuses.length,
      buses: enrichedBuses,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch nearest-stop buses" });
  }
};

// GET /api/location/nearest-stop - Returns ONLY ONE nearest bus
async function getNearestSingleBus(req, res) {
  try {
    // Validate query params
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Missing or invalid lat/lng query parameters" });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "Lat/lng out of valid range" });
    }

    // Fetch all bus locations from MongoDB
    const buses = await Bus.find({ status: "active" })
      .select("busId lat lng location speed heading status lastUpdate")
      .lean();

    // Handle empty DB case
    if (!buses || buses.length === 0) {
      return res.status(404).json({ error: "No buses found in database" });
    }

    // Stale threshold: 60 seconds
    const STALE_THRESHOLD_MS = 60 * 1000;
    const now = Date.now();

    // Compute nearest using Haversine formula (in meters)
    let nearestBus = null;
    let minDistanceMeters = Infinity;

    for (const bus of buses) {
      const busLat = Number(bus.lat);
      const busLng = Number(bus.lng);

      // Filter invalid coordinates
      if (!Number.isFinite(busLat) || !Number.isFinite(busLng)) continue;

      // Ignore stale buses (updatedAt older than 60 seconds)
      const updatedAt = bus.updatedAt || bus.timestamp;
      if (updatedAt) {
        const busTime = new Date(updatedAt).getTime();
        if (now - busTime > STALE_THRESHOLD_MS) continue;
      }

      // Haversine formula (R = 6371000 meters)
      const R = 6371000;
      const dLat = ((busLat - lat) * Math.PI) / 180;
      const dLng = ((busLng - lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat * Math.PI) / 180) *
          Math.cos((busLat * Math.PI) / 180) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distanceMeters = R * c;

      if (distanceMeters < minDistanceMeters) {
        minDistanceMeters = distanceMeters;
        nearestBus = bus;
      }
    }

    // Handle case where no valid bus found
    if (!nearestBus) {
      return res.status(404).json({ error: "No valid or recent bus locations found" });
    }

    // Prevent null crashes - validate nearestBus before accessing
    if (!nearestBus.busId || !nearestBus.lat || !nearestBus.lng) {
      return res.status(404).json({ error: "Nearest bus has invalid data" });
    }

    // Return single bus object with distance
    return res.status(200).json({
      busId: nearestBus.busId,
      latitude: Number(nearestBus.lat),
      longitude: Number(nearestBus.lng),
      distanceMeters: Math.round(minDistanceMeters),
      updatedAt: nearestBus.updatedAt || nearestBus.timestamp,
    });
  } catch (error) {
    console.error("[ERROR] getNearestSingleBus:", error);
    return res.status(500).json({ error: "Server error fetching nearest bus" });
  }
}

async function getAllBusLocations(req, res) {
  try {
    // Only return buses that are currently tracking (active in backend authority)
    const allBuses = await Bus.find({});
    const buses = allBuses.filter(b => isTrackingActive(b.busId));

    const formatted = buses.map(b => ({
      _id: b._id,
      lat: b.lat || b.location?.coordinates?.[1],
      lng: b.lng || b.location?.coordinates?.[0],
      status: b.status || "normal"
    }));

    return res.json(formatted);
  } catch (err) {
    console.error("[getAllBusLocations]", err);
    return res.status(500).json({ error: "Failed to fetch buses" });
  }
}

// Controller to start tracking for a bus
const startTracking = async (req, res) => {
  try {
    console.log("[BACKEND] ========== START TRACKING ==========");
    console.log("[BACKEND] req.body:", req.body);
    
    const { busId } = req.body;
    if (!busId) {
      console.log("[BACKEND] ❌ Missing busId");
      return res.status(400).json({ error: "busId required" });
    }
    
    console.log("[BACKEND] Initializing tracking state for:", busId);
    setTrackingActive(busId, true);
    
    const newState = trackingState.get(busId);
    console.log("[BACKEND] ✅ Tracking started:", busId, "State:", newState);
    
    return res.json({ success: true, message: "Tracking started", busId });
  } catch (err) {
    console.error("[BACKEND] 🔥 START TRACKING ERROR:", err.message);
    console.error("[BACKEND] Stack:", err.stack);
    return res.status(500).json({ error: "Failed to start tracking", message: err.message });
  }
};

// Controller to stop tracking for a bus
const stopTracking = async (req, res) => {
  try {
    console.log("[BACKEND] ========== STOP TRACKING ==========");
    console.log("[BACKEND] req.body:", req.body);
    
    const { busId } = req.body;
    if (!busId) {
      console.log("[BACKEND] ❌ Missing busId");
      return res.status(400).json({ error: "busId required" });
    }
    
    const io = req.app.get("io");
    console.log("[BACKEND] Stopping tracking for:", busId);
    setTrackingActive(busId, false, io);
    
    console.log("[BACKEND] ✅ Tracking stopped:", busId);
    return res.json({ success: true, message: "Tracking stopped", busId });
  } catch (err) {
    console.error("[BACKEND] 🔥 STOP TRACKING ERROR:", err.message);
    console.error("[BACKEND] Stack:", err.stack);
    return res.status(500).json({ error: "Failed to stop tracking", message: err.message });
  }
};

module.exports = {
  updateLocation,
  getAllBusLocations,
  getNearestStopHandler,
  getNearestSingleBus,
  startTracking,
  stopTracking
};
