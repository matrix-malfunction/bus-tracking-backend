const Location = require("../models/Location");
const Bus = require("../models/Bus");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const { haversineKm } = require("../services/etaService");
const { defaultCache } = require("../services/locationCache");

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes for stale data

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
  if (!Number.isFinite(stamp) || stamp <= 0) return true; // Consider invalid timestamps as stale
  return nowMs - stamp > ACTIVE_WINDOW_MS;
}

function isValidCoordinate(lat, lng) {
  const numLat = Number(lat);
  const numLng = Number(lng);
  return (
    Number.isFinite(numLat) &&
    Number.isFinite(numLng) &&
    numLat >= -90 &&
    numLat <= 90 &&
    numLng >= -180 &&
    numLng <= 180
  );
}

function chooseBestSource(location, nowMs = Date.now()) {
  // Check ESP32 snapshot first (hardware has priority)
  if (location?.esp32Snapshot?.timestamp) {
    const esp32Ts = new Date(location.esp32Snapshot.timestamp).getTime();
    if (nowMs - esp32Ts <= STALE_THRESHOLD_MS) {
      return {
        source: "hardware",
        lat: location.esp32Snapshot.lat,
        lng: location.esp32Snapshot.lng,
        speed: location.esp32Snapshot.speed || 0,
        timestamp: location.esp32Snapshot.timestamp,
      };
    }
  }

  // Fall back to mobile snapshot
  if (location?.mobileSnapshot?.timestamp) {
    const mobileTs = new Date(location.mobileSnapshot.timestamp).getTime();
    if (nowMs - mobileTs <= STALE_THRESHOLD_MS) {
      return {
        source: "mobile",
        lat: location.mobileSnapshot.lat,
        lng: location.mobileSnapshot.lng,
        speed: location.mobileSnapshot.speed || 0,
        timestamp: location.mobileSnapshot.timestamp,
      };
    }
  }

  return null;
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

exports.updateLocation = async (req, res) => {
  try {
    console.log("📥 RAW BODY:", JSON.stringify(req.body));

    const { busId, lat, lng, source } = req.body;

    // Validation
    if (!busId || typeof busId !== "string" || busId.trim() === "") {
      console.log("❌ Missing or invalid busId:", busId);
      return res.status(400).json({ error: "Missing or invalid busId" });
    }

    // Validate lat/lng are numbers and not null
    if (lat === null || lat === undefined || lng === null || lng === undefined) {
      console.log("❌ Coordinates cannot be null:", { lat, lng });
      return res.status(400).json({ error: "lat and lng are required" });
    }

    if (isNaN(Number(lat)) || isNaN(Number(lng))) {
      console.log("❌ Coordinates must be valid numbers:", { lat, lng });
      return res.status(400).json({ error: "lat and lng must be numbers" });
    }

    if (!isValidCoordinate(lat, lng)) {
      console.log("❌ Invalid coordinate ranges:", { lat, lng });
      return res.status(400).json({ error: "Invalid coordinates. lat: -90 to 90, lng: -180 to 180" });
    }

    const normalizedSource = source === "hardware" ? "hardware" : "mobile";
    const now = new Date();
    const numLat = Number(lat);
    const numLng = Number(lng);

    // GeoJSON format: [longitude, latitude]
    const geoLocation = {
      type: "Point",
      coordinates: [numLng, numLat],
    };

    // Prepare snapshot data
    const snapshotData =
      normalizedSource === "hardware"
        ? {
            esp32Snapshot: {
              lat: numLat,
              lng: numLng,
              speed: 0,
              timestamp: now,
            },
          }
        : {
            mobileSnapshot: {
              lat: numLat,
              lng: numLng,
              speed: 0,
              timestamp: now,
            },
          };

    // Upsert with atomic operation
    const location = await Location.findOneAndUpdate(
      { busId: busId.trim() },
      {
        $set: {
          busId: busId.trim(),
          latitude: numLat,
          longitude: numLng,
          location: geoLocation,
          source: normalizedSource,
          updatedAt: now,
          timestamp: now,
          ...snapshotData,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    console.log("✅ SAVED TO DB:", {
      busId: location.busId,
      lat: location.latitude,
      lng: location.longitude,
      geo: location.location,
      source: location.source,
    });

    // Emit socket update with route intelligence
    const io = req.app.get("io");
    if (io) {
      // Get route info if available
      const Route = require("../models/Route");
      let routeInfo = null;
      
      try {
        const route = await Route.findById(location.routeId);
        if (route) {
          const { getBusRouteIntelligence } = require("../utils/routeIntelligence");
          routeInfo = getBusRouteIntelligence(
            { latitude: location.latitude, longitude: location.longitude, speed: 0, busId: location.busId },
            route,
            location.busId
          );
        }
      } catch (err) {
        // Route not found or error, continue without route info
      }
      
      io.emit("busLocationUpdate", {
        busId: location.busId,
        lat: location.latitude,
        lng: location.longitude,
        source: location.source,
        location: location.location,
        updatedAt: location.updatedAt,
        routeInfo: routeInfo ? {
          routeName: routeInfo.routeName,
          nextStop: routeInfo.nextStop,
          stopsAway: routeInfo.stopsAway,
          etaMinutes: routeInfo.etaMinutes,
          routeDistanceKm: routeInfo.routeDistanceKm,
          progress: routeInfo.progress,
          isConfident: routeInfo.isConfident,
          smoothedSpeedKmh: routeInfo.smoothedSpeedKmh,
          trafficMultiplier: routeInfo.trafficMultiplier,
          isMovingForward: routeInfo.isMovingForward,
        } : null,
      });
      console.log("📡 busLocationUpdate emitted:", location.busId);
    }

    return res.status(200).json({
      success: true,
      data: {
        busId: location.busId,
        latitude: location.latitude,
        longitude: location.longitude,
        location: location.location,
        source: location.source,
        updatedAt: location.updatedAt,
      },
    });
  } catch (err) {
    console.error("🔥 BACKEND ERROR:", err.message);
    console.error(err.stack);
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
      // Use hybrid source selection to get best coordinates
      const best = chooseBestSource(item, nowMs);
      if (best) {
        return {
          busId: item.busId,
          latitude: best.lat,
          longitude: best.lng,
          speed: Number(best.speed) || 0,
          source: best.source,
          routeId: item.routeId || null,
          updatedAt: best.timestamp,
          timestamp: best.timestamp,
          name: item.name || item.busId,
        };
      }

      // Fallback to direct coordinates if no snapshot available
      const latitude = Number(item?.latitude ?? item?.lat);
      const longitude = Number(item?.longitude ?? item?.lng);
      const valid = Number.isFinite(latitude) && Number.isFinite(longitude);
      if (!valid) return null;
      return {
        busId: item.busId,
        latitude,
        longitude,
        speed: Number(item.speed) || 0,
        source: item.source || "unknown",
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
      const dbCandidatesRaw = await Location.find({})
        .sort({ updatedAt: -1, timestamp: -1 })
        .limit(50)
        .select("busId latitude longitude lat lng speed routeId updatedAt timestamp mobileSnapshot esp32Snapshot source")
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
}

exports.getAllBusLocations = async (req, res) => {
  try {
    const nowMs = Date.now();
    const allLocations = await Location.find({}).lean();

    // Load all routes for intelligence
    const Route = require("../models/Route");
    const routes = await Route.find({}).lean();
    const routeMap = new Map(routes.map(r => [r._id.toString(), r]));
    
    const { getBusRouteIntelligence } = require("../utils/routeIntelligence");

    // Filter out stale and invalid data
    const validBuses = await Promise.all(
      allLocations
        .map(async (loc) => {
          const best = chooseBestSource(loc, nowMs);
          if (!best) return null;
          
          // Get route intelligence if routeId exists
          let routeInfo = null;
          if (loc.routeId) {
            const route = routeMap.get(loc.routeId.toString());
            if (route) {
              routeInfo = getBusRouteIntelligence(
                { latitude: best.lat, longitude: best.lng, speed: 0, busId: loc.busId },
                route,
                loc.busId
              );
            }
          }
          
          return {
            busId: loc.busId,
            latitude: best.lat,
            longitude: best.lng,
            source: best.source,
            updatedAt: getTime(loc).toISOString(),
            routeInfo: routeInfo ? {
              routeName: routeInfo.routeName,
              nextStop: routeInfo.nextStop,
              stopsAway: routeInfo.stopsAway,
              etaMinutes: routeInfo.etaMinutes,
              routeDistanceKm: routeInfo.routeDistanceKm,
              progress: routeInfo.progress,
              isConfident: routeInfo.isConfident,
              smoothedSpeedKmh: routeInfo.smoothedSpeedKmh,
              trafficMultiplier: routeInfo.trafficMultiplier,
              isMovingForward: routeInfo.isMovingForward,
              allStops: routeInfo.allStops,
            } : null,
          };
        })
        .filter(Boolean)
    );

    return res.status(200).json({
      count: validBuses.length,
      buses: validBuses,
    });
  } catch (err) {
    console.error("❌ Failed to fetch buses:", err.message);
    res.status(500).json({ error: "Failed to fetch buses" });
  }
};

module.exports = {
  updateLocation: exports.updateLocation,
  getAllBusLocations: exports.getAllBusLocations,
  getNearestStop: getNearestStopHandler,
};
