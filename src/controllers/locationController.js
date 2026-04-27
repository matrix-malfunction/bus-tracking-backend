const Bus = require("../models/Bus");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const DriverEmergency = require("../models/DriverEmergency");
const { isTrackingActive, setTrackingActive } = require("../utils/trackingState");

// Helper: Check if SOS is active for bus
const checkSOS = async (busId) => {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const now = Date.now();
  
  const sos = await DriverEmergency.findOne({
    busId,
    $and: [
      {
        $or: [
          { status: { $in: ["active", "sos", "SOS"] } },
          { type: "emergency" }
        ]
      },
      {
        $or: [
          { lastUpdate: { $gte: new Date(now - FIVE_MINUTES) } },
          { createdAt: { $gte: new Date(now - FIVE_MINUTES) } }
        ]
      }
    ]
  });
  
  return !!sos;
};
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
  try {
    console.log("📥 RAW BODY:", req.body);
    console.log("STEP 1 - Incoming lat/lng:", { 
      busId: req.body.busId, 
      lat: req.body.lat, 
      lng: req.body.lng,
      latType: typeof req.body.lat,
      lngType: typeof req.body.lng
    });

    const { busId, source } = req.body;
    
    // BACKEND AUTHORITY: Check tracking state
    if (!isTrackingActive(busId)) {
      console.log("[BACKEND] BLOCKED - tracking inactive:", busId);
      return res.status(403).json({ error: "Tracking not active" });
    }
    
    // BACKEND AUTHORITY: Check SOS status
    const sosActive = await checkSOS(busId);
    if (sosActive) {
      console.log("[BACKEND] BLOCKED - SOS active:", busId);
      return res.status(403).json({ error: "SOS active - tracking paused" });
    }
    
    // Handle both lat/lng and latitude/longitude property names
    const lat = req.body.lat ?? req.body.latitude;
    const lng = req.body.lng ?? req.body.longitude;

    if (!busId || lat == null || lng == null) {
      console.log("❌ Missing fields:", { busId, lat, lng, body: req.body });
      return res.status(400).json({ error: "Missing fields" });
    }

    // STRICT VALIDATION - Reject null/invalid lat/lng
    const numLat = Number(lat);
    const numLng = Number(lng);
    
    if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
      console.log("❌ Invalid lat/lng:", { lat, lng, numLat, numLng });
      return res.status(400).json({ error: "Invalid lat/lng values" });
    }
    
    if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
      console.log("❌ Out of range lat/lng:", { numLat, numLng });
      return res.status(400).json({ error: "Lat/lng out of valid range" });
    }

    // Update geospatial Bus model (single source of truth)
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

    console.log("✅ SAVED TO DB (Bus model):", {
      busId: updated.busId,
      lat: numLat,
      lng: numLng,
      location: updated.location
    });
    // Sync SOS lastUpdate with driver activity (update ONLY latest record)
    await DriverEmergency.findOneAndUpdate(
      {
        busId: req.body.busId,
        $or: [
          { status: { $in: ["active", "sos", "SOS"] } },
          { type: "emergency" }
        ]
      },
      {
        $set: { lastUpdate: new Date() }
      },
      {
        sort: { createdAt: -1, _id: -1 }   // stable event ordering
      }
    );

    const io = req.app.get("io");

    if (io) {
      io.emit("busLocationUpdate", {
        busId,
        lat,
        lng,
      });

      console.log("📡 busLocationUpdate emitted:", busId);

      const route = await Route.findOne({ routeName: "Vellore Route" });

      if (!route || !route.stops || route.stops.length === 0) {
        console.log("⚠️ No route data found");
      } else {
        const next = await getNextStop(Number(lat), Number(lng), route);

        // average speed (adjustable)
        const avgSpeed = 30; // km/h
        const etaMinutes = Math.max(1, Math.round((next.distance / avgSpeed) * 60));

        io.emit("busETAUpdate", {
          busId,
          nextStop: next.stop.name,
          eta: etaMinutes,
        });

        console.log("🕒 ETA EMITTED:", next.stop.name, etaMinutes);
      }
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("🔥 BACKEND ERROR:", err);
    res.status(500).json({ error: "Server error" });
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
    const { busId } = req.body;
    if (!busId) {
      return res.status(400).json({ error: "busId required" });
    }
    setTrackingActive(busId, true);
    return res.json({ success: true, message: "Tracking started", busId });
  } catch (err) {
    console.error("[START TRACKING ERROR]", err);
    return res.status(500).json({ error: "Failed to start tracking" });
  }
};

// Controller to stop tracking for a bus
const stopTracking = async (req, res) => {
  try {
    const { busId } = req.body;
    if (!busId) {
      return res.status(400).json({ error: "busId required" });
    }
    const io = req.app.get("io");
    setTrackingActive(busId, false, io);
    return res.json({ success: true, message: "Tracking stopped", busId });
  } catch (err) {
    console.error("[STOP TRACKING ERROR]", err);
    return res.status(500).json({ error: "Failed to stop tracking" });
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
