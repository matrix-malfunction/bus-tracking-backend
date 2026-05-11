const Bus = require("../models/Bus");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");
const DriverEmergency = require("../models/DriverEmergency");
const { isTrackingActive, setTrackingActive, getTrackingState, trackingState, setBusRoute, getBusRoute, computeDerivedSpeed, getBusProgression } = require("../utils/trackingState");
const routes = require("../../data/routes"); // Route master data
const { computeBusProgression, hasProgressionChanged, GPS_JITTER_THRESHOLD_METERS, onStopEvent, toLatLng, projectOntoRouteCorridor } = require("../utils/progressionEngine");
const { ALL_STOPS, getStopNameById } = require("../services/overpassService");
// Speed comes directly from driver app - no backend recalculation needed

const { chooseBestSource } = require("../services/hybridSourceSelector");
const { haversineKm } = require("../services/etaService");
const { defaultCache } = require("../services/locationCache");

// ===== STOP ARRIVALS MAP =====
// In-memory: stopId → { stopId, stopName, arrivals: [...] }
const stopArrivalsMap = new Map();

function _setArrivalEntry(stopId, stopName, arrival) {
  const key = String(stopId);
  if (!stopArrivalsMap.has(key)) {
    stopArrivalsMap.set(key, { stopId: key, stopName: stopName || key, arrivals: [] });
  }
  const entry = stopArrivalsMap.get(key);
  if (stopName) entry.stopName = stopName;
  entry.arrivals = entry.arrivals.filter(a => a.busId !== arrival.busId);
  entry.arrivals.push(arrival);
  const statusOrder = { AT_STOP: 0, ARRIVING: 1, UPCOMING: 2, DEPARTED: 3 };
  entry.arrivals.sort((a, b) => {
    const aO = statusOrder[a.status] ?? 2;
    const bO = statusOrder[b.status] ?? 2;
    if (aO !== bO) return aO - bO;
    if (a.etaMinutes == null) return 1;
    if (b.etaMinutes == null) return -1;
    return a.etaMinutes - b.etaMinutes;
  });
  if (entry.arrivals.length > 5) entry.arrivals = entry.arrivals.slice(0, 5);
}

function updateStopArrivals(busId, progression, routeForProgression, routeInfoArg) {
  if (!busId || !progression) return;
  const { currentStopId, currentStopName, nextStopId, nextStopName, etaMinutes, nextStopIndex } = progression;
  const routeMeta = routeForProgression || routeInfoArg || {};
  const arrivalBase = {
    busId,
    routeId: routeMeta.routeId || null,
    routeName: routeMeta.routeName || null,
    direction: routeMeta.direction || null,
    lastUpdate: Date.now()
  };
  if (currentStopId) {
    _setArrivalEntry(currentStopId, currentStopName, {
      ...arrivalBase,
      etaMinutes: 0,
      currentStopName: currentStopName || null,
      nextStopName: nextStopName || null,
      status: 'AT_STOP'
    });
  }
  if (nextStopId) {
    const nextStatus = (etaMinutes != null && etaMinutes <= 1) ? 'ARRIVING' : 'UPCOMING';
    _setArrivalEntry(nextStopId, nextStopName, {
      ...arrivalBase,
      etaMinutes: etaMinutes != null ? etaMinutes : null,
      currentStopName: currentStopName || null,
      nextStopName: nextStopName || null,
      status: nextStatus
    });
  }
  const routeStops = routeMeta.stops;
  if (Array.isArray(routeStops) && nextStopIndex >= 0) {
    const upEnd = Math.min(nextStopIndex + 4, routeStops.length);
    for (let i = nextStopIndex + 1; i < upEnd; i++) {
      const raw = routeStops[i];
      const sid = typeof raw === 'object' ? (raw.id || raw._id) : raw;
      if (!sid) continue;
      const sname = (typeof raw === 'object' ? raw.name : null) || getStopNameById(sid) || String(sid);
      _setArrivalEntry(sid, sname, {
        ...arrivalBase,
        etaMinutes: null,
        currentStopName: currentStopName || null,
        nextStopName: nextStopName || null,
        status: 'UPCOMING'
      });
    }
  }
}

function clearBusFromStopArrivals(busId) {
  stopArrivalsMap.forEach((entry, stopId) => {
    entry.arrivals = entry.arrivals.filter(a => a.busId !== busId);
    if (entry.arrivals.length === 0) stopArrivalsMap.delete(stopId);
  });
  console.log('[STOP ARRIVALS] Cleared bus:', busId);
}
// ===== END STOP ARRIVALS =====

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const EMIT_DISTANCE_THRESHOLD_METERS = 15;
const MIN_SPEED_KMPH = 10;
const DEFAULT_SPEED_KMPH = 30;
const MAX_SPEED_KMPH = 80;
const MIN_SPEED_MPS = 5 / 3.6; // 5 km/h dead-zone filter (~1.39 m/s)
const STOP_THRESHOLD_METERS = 15;
const MIN_TIME_DIFF_SEC = 3;
// Use unified GPS jitter threshold from progression engine
const JITTER_THRESHOLD_METERS = GPS_JITTER_THRESHOLD_METERS;

/**
 * Normalize route data to ensure consistent field names
 * Handles migration between route.coordinates and route.routeCoords
 */
function normalizeRoute(route) {
  if (!route) return null;

  return {
    ...route,

    // CRITICAL FIX:
    // support both legacy and current route field names
    routeCoords:
      route.routeCoords ||
      route.coordinates ||
      [],

    stops:
      Array.isArray(route.stops)
        ? route.stops
        : [],
  };
}

// STOP EVENT ENGINE: Register callback to emit socket events
// This creates backend-authoritative ARRIVAL/DEPARTURE/DWELLING/APPROACHING events
onStopEvent((eventType, payload) => {
  const { io } = require("../server");
  if (io) {
    io.emit("BUS_STOP_EVENT", {
      type: eventType, // ARRIVED, DEPARTED, DWELLING, APPROACHING
      ...payload,
      timestamp: new Date().toISOString()
    });
    
    // Also log for debugging
    console.log(`[BACKEND] BUS_STOP_EVENT emitted: ${eventType}`, {
      busId: payload.busId,
      stopId: payload.stopId,
      stopName: payload.stopName
    });
  }
});

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

/**
 * Sanitize number for safe serialization
 * Returns finite numbers only, else null
 */
function sanitizeNumber(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Create safe fallback payload for degraded mode
 */
function createFallbackPayload(busId, lat, lng) {
  return {
    busId,
    lat: sanitizeNumber(lat) ?? null,
    lng: sanitizeNumber(lng) ?? null,
    speed: 0,
    heading: 0,
    isSnapped: false,
    snappedLat: null,
    snappedLng: null,
    distanceFromRoute: null,
    routeId: null,
    nextStopId: null,
    nextStopName: null,
    nextStopEtaMinutes: null,
    remainingDistanceMeters: null,
    status: "active",
    timestamp: new Date().toISOString(),
    degraded: true
  };
}

async function updateLocation(req, res) {
  // Final safety wrapper - NEVER crash the driver
  try {
    await _updateLocationUnsafe(req, res);
  } catch (fatalError) {
    console.error("[CONTROLLER FATAL]", {
      error: fatalError.message,
      stack: fatalError.stack?.split('\n')[0],
      body: req.body
    });
    
    // Return HTTP 200 with degraded response
    const fallbackBusId = req.body?.busId || "unknown";
    const fallbackLat = Number(req.body?.lat) || null;
    const fallbackLng = Number(req.body?.lng) || null;
    
    res.status(200).json({
      success: true,
      degraded: true,
      message: "Location recorded (degraded mode)",
      busId: fallbackBusId,
      fallbackPayload: createFallbackPayload(fallbackBusId, fallbackLat, fallbackLng)
    });
  }
}

async function _updateLocationUnsafe(req, res) {
  // FLOW TELEMETRY STEP 1: Controller entry
  console.log("[FLOW] STEP 1 - Controller entry");
  
  // Log immediately upon entry - confirms controller is reached
  console.log("[BACKEND] ========== LOCATION UPDATE ==========");
  console.log("[BACKEND] req.body:", JSON.stringify(req.body, null, 2));
  console.log("[BACKEND] req.path:", req.path);
  console.log("[BACKEND] req.method:", req.method);
  
  try {
    const io = req.app.get("io");
    console.log("[BACKEND] io exists:", !!io);
    
    const { busId, source, speed: driverSpeed, heading: driverHeading } = req.body;
    const lat = req.body.lat ?? req.body.latitude;
    const lng = req.body.lng ?? req.body.longitude;
    const accuracy = req.body.accuracy ?? req.body.coords?.accuracy ?? null;
    
    console.log("[BACKEND] Parsed values:", { busId, lat, lng, source });

    console.log("[LOCATION UPDATE RECEIVED]", {
      busId,
      lat,
      lng,
      timestamp: Date.now(),
    });

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
    
    // === TRACKING STATE GUARD ===
    // Require existing state from startTracking - do NOT auto-init
    // This prevents stale packets from reviving stopped buses
    let state = trackingState.get(busId);
    console.log("[BACKEND] trackingState exists:", !!state);

    if (!state) {
      console.log("[BACKEND] BLOCKED - no tracking state (bus never started):", busId);
      return res.status(403).json({
        error: "Tracking not started",
        ignored: true
      });
    }

    // Block stale packets from inactive buses
    if (state?.trackingActive === false) {
      console.log("[BACKEND BLOCKED] inactive bus packet:", busId);
      return res.status(200).json({
        ignored: true,
        inactive: true
      });
    }

    // === HANDLE STOP SIGNAL ===
    // If driver sends trackingActive: false, mark bus offline immediately
    if (req.body.trackingActive === false) {
      console.log("[BACKEND] STOP signal received for:", busId);

      // Use setTrackingActive to properly emit BUS_OFFLINE and delete from trackingState
      setTrackingActive(busId, false, io);

      // Clean ghost arrivals for this bus
      clearBusFromStopArrivals(busId);
      try {
        const arrivalsPayload = { stopArrivals: Object.fromEntries(stopArrivalsMap) };
        io.emit('STOP_ARRIVALS_UPDATE', JSON.parse(JSON.stringify(arrivalsPayload)));
      } catch (e) {}

      return res.json({
        success: true,
        offline: true,
        message: "Tracking stopped",
        busId,
        trackingActive: false
      });
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
    
    // FLOW TELEMETRY STEP 2: After validation
    console.log("[FLOW] STEP 2 - Validation passed");
    
    // === UPDATE DATABASE ===
    let updated;
    try {
      // Sanitize coordinates for DB storage
      const safeLat = sanitizeNumber(numLat);
      const safeLng = sanitizeNumber(numLng);
      
      if (!safeLat || !safeLng) {
        throw new Error(`Invalid coordinates: lat=${numLat}, lng=${numLng}`);
      }
      
      updated = await Bus.findOneAndUpdate(
        { busId: busId.trim() },
        {
          $set: {
            busId: busId.trim(),
            location: {
              type: "Point",
              coordinates: [safeLng, safeLat],
            },
            lat: safeLat,
            lng: safeLng,
            speed: sanitizeNumber(req.body.speed) || 0,
            heading: sanitizeNumber(req.body.heading) || 0,
            status: "active",
            lastUpdate: new Date(),
          },
        },
        { upsert: true, new: true }
      );
      
      console.log("[BACKEND] ✅ Saved to DB:", {
        busId: updated.busId,
        lat: safeLat,
        lng: safeLng
      });
    } catch (dbError) {
      console.error("[BACKEND] ❌ DB Update Failed:", dbError.message);
      // Continue with degraded mode - don't let DB failure break tracking
      updated = {
        busId: busId.trim(),
        lat: numLat,
        lng: numLng,
        speed: req.body.speed || 0,
        heading: req.body.heading || 0,
        status: "active",
        lastUpdate: new Date()
      };
    }
    
    // FLOW TELEMETRY STEP 4: After DB update
    console.log("[FLOW] STEP 4 - After DB update");
    
    // === USE DRIVER-COMPUTED SPEED (Single Source of Truth) ===
    // Backend does NOT recalculate - uses speed from driver app
    const rawDriverSpeed = Number(driverSpeed) || 0;
    const heading = Number(driverHeading) || 0;

    // DEAD-ZONE FILTER: If speed < 5 km/h, consider stationary (prevents UI noise)
    const speed = rawDriverSpeed < MIN_SPEED_MPS ? 0 : rawDriverSpeed;

    console.log("[BACKEND] Using driver speed:", rawDriverSpeed, "m/s (", Math.round(rawDriverSpeed * 3.6), "km/h)");
    if (speed === 0 && rawDriverSpeed > 0) {
      console.log("[BACKEND] Speed filtered to 0 (below 5 km/h threshold)");
    }

    // === COMPUTE DERIVED SPEED FOR RELIABLE MOVEMENT DETECTION ===
    // Compute speed from position changes (more reliable than Expo GPS speed)
    const timestamp = Date.now();
    const { derivedSpeed } = computeDerivedSpeed(busId, numLat, numLng, timestamp);
    
    // === COMPUTE BUS PROGRESSION (ETA, Stop Detection, Events) ===
    // CRITICAL: Progression is optional enrichment - tracking must survive failures
    // HOISTED: routeInfo declared here — prevents TDZ ReferenceError inside try block
    const routeInfo = getBusRoute(busId);
    let progression = null;
    let routeForProgression = null;
    try {
      // Use normalizeRoute to handle field name migration (coordinates -> routeCoords)
      routeForProgression = normalizeRoute(routeInfo);

      // TELEMETRY: Route data before computeBusProgression
      console.log("[ROUTE TELEMETRY]", {
        busId,
        hasRouteInfo: !!routeInfo,
        routeId: routeForProgression?.routeId || null,
        hasRouteCoords: !!(routeForProgression?.routeCoords && routeForProgression?.routeCoords.length > 0),
        routeCoordsLength: routeForProgression?.routeCoords?.length || 0,
        firstCoord: routeForProgression?.routeCoords?.[0] || null,
        lastCoord: routeForProgression?.routeCoords?.[routeForProgression?.routeCoords?.length - 1] || null,
        hasStops: !!(routeForProgression?.stops && routeForProgression?.stops.length > 0),
        stopsLength: routeForProgression?.stops?.length || 0,
        firstStop: routeForProgression?.stops?.[0] || null,
        source: routeInfo ? "routeInfo" : "none"
      });

      console.log("[MOVEMENT DELTA]", {
        busId,
        previousLat: state?.location?.lat,
        previousLng: state?.location?.lng,
        currentLat: numLat,
        currentLng: numLng,
      });

      // FLOW TELEMETRY STEP 5: Before computeBusProgression
      console.log("[FLOW] STEP 5 - Before computeBusProgression");

      const safeRouteCoordinates = routeForProgression?.routeCoords || [];
      const safeStops = routeForProgression?.stops || [];

      if (!safeRouteCoordinates.length || safeRouteCoordinates.length < 2) {
        console.log("[PROGRESSION BLOCKED] Invalid route coordinates", {
          busId,
          routeId: routeForProgression?.routeId,
          coords: safeRouteCoordinates.length,
        });
      } else {
        console.log("[PROGRESSION INPUT]", {
          busId,
          routePoints: safeRouteCoordinates.length,
          stops: safeStops.length,
          lat: numLat,
          lng: numLng,
        });

        console.log("[GEOMETRY CHECK]", {
          busId,
          gps: { lat: numLat, lng: numLng },
          firstRoutePoint: safeRouteCoordinates[0],
          lastRoutePoint: safeRouteCoordinates[safeRouteCoordinates.length - 1],
          routePoints: safeRouteCoordinates.length,
        });

        progression = computeBusProgression(
          busId,
          numLat,
          numLng,
          speed,
          { ...routeForProgression, routeCoords: safeRouteCoordinates, stops: safeStops },
          accuracy
        );

        console.log("[PROJECTION RESULT]", {
          projected: !!progression,
          snappedLat: progression?.lastProjectedPoint?.lat || null,
          snappedLng: progression?.lastProjectedPoint?.lng || null,
          distance: progression?.distanceFromCorridor || null,
        });

        console.log("[PROGRESSION RESULT]", {
          busId,
          currentStopName: progression?.currentStopName,
          nextStopName: progression?.nextStopName,
          nextStopEtaMinutes: progression?.etaMinutes,
          routeProgressIndex: progression?.currentStopIndex,
        });

        if (!progression?.lastProjectedPoint) {
          console.warn("[PROJECTION FAILED]", {
            busId,
            gps: { lat: numLat, lng: numLng },
            routePoints: safeRouteCoordinates.length,
            distanceFromRoute: progression?.distanceFromCorridor ?? null,
          });
        }
      }

      if (progression) {
        console.log("[LOCATION]", "COMPUTE_RESPONSE", {
          busId,
          hasProgression: true,
          isSnapped: !!(progression?.lastProjectedPoint),
          snappedLat: progression?.lastProjectedPoint?.lat || null,
          currentStopId: progression?.currentStopId || null,
          nextStopId: progression?.nextStopId || null,
          nextStopName: progression?.nextStopName || null,
          nextStopEtaMinutes: progression?.nextStopEtaMinutes || null,
        });
      }
    } catch (progressionError) {
      console.error("[PROGRESSION] FAILED", {
        busId,
        error: progressionError.message,
        stack: progressionError.stack?.split('\n')[0]
      });
      // Progression failure is non-fatal - continue tracking
      progression = null;
    }
    
    // FLOW TELEMETRY STEP 6: After computeBusProgression
    console.log("[FLOW] STEP 6 - After computeBusProgression");

    // === ROUTE SNAPPING (Corridor Locking) ===
    // Calculate snapped coordinates for professional AVL-style rendering
    // CRITICAL: This is an optional enhancement - tracking must continue even if snapping fails
    let snappedCoords = null;
    
    // EXECUTION TRACE: Track route lookup (routeInfo already hoisted above)
    console.log("[SNAP TRACE] busId:", busId, "routeInfo:", routeInfo);
    
    let routeData = null;
    if (routeInfo && routeInfo.routeId) {
      routeData = routes.find(r => r.id === routeInfo.routeId);
      console.log("[SNAP TRACE] Looking for routeId:", routeInfo.routeId, "found:", !!routeData);
    }
    
    // Normalize route coordinate access (handle both formats)
    const routeCoords =
      routeData?.routeCoords ||
      routeData?.coordinates ||
      null;
    
    console.log("[SNAP TRACE] coords source:", {
      hasRouteCoords: !!routeData?.routeCoords,
      hasCoordinates: !!routeData?.coordinates,
      coordsCount: Array.isArray(routeCoords) ? routeCoords.length : 0
    });
    
    if (routeCoords && routeCoords.length >= 2) {
      try {
        console.log("[SNAP TRACE] Invoking snapToRouteCorridor...");
        // Import snapToRouteCorridor from progressionEngine
        const { snapToRouteCorridor } = require("../utils/progressionEngine");
        snappedCoords = snapToRouteCorridor(numLat, numLng, routeCoords);
        
        console.log("[SNAP TRACE] snap result:", snappedCoords ? {
          hasSnappedLat: !!snappedCoords.snappedLat,
          hasSnappedLng: !!snappedCoords.snappedLng,
          distance: Math.round(snappedCoords.distanceFromRoute),
          isSnapped: snappedCoords.isSnapped
        } : null);
        
        if (snappedCoords) {
          console.log("[BACKEND] Route snapping:", {
            busId,
            raw: [numLat, numLng],
            snapped: [snappedCoords.snappedLat, snappedCoords.snappedLng],
            distanceFromRoute: Math.round(snappedCoords.distanceFromRoute),
            isSoftSnap: snappedCoords.isSoftSnap || false
          });
        }
      } catch (error) {
        // CRITICAL: Never let snapping failures break the tracking pipeline
        console.error("[Route Snap] Failed for bus", busId, ":", error.message);
        snappedCoords = null;
      }
    } else {
      console.log("[SNAP TRACE] No valid routeCoords - skipping snapping");
    }

    // === SOCKET EMIT ===
    // CRITICAL: Socket emit failure must not break tracking
    try {
      if (io && busId && Number.isFinite(numLat) && Number.isFinite(numLng)) {
        // Sanitize all numeric fields for safe serialization
        const emitPayload = {
          busId: busId.trim(),
          // Timestamp for stale packet protection
          timestamp: Date.now(),
          // Raw GPS coordinates (always included)
          latitude: sanitizeNumber(numLat),
          longitude: sanitizeNumber(numLng),
          // Snapped coordinates (if within route corridor)
          ...(snappedCoords && {
            snappedLat: sanitizeNumber(snappedCoords.snappedLat),
            snappedLng: sanitizeNumber(snappedCoords.snappedLng),
            isSnapped: true,
            distanceFromRoute: sanitizeNumber(snappedCoords.distanceFromRoute),
            isSoftSnap: snappedCoords.isSoftSnap || false
          }),
          speed: sanitizeNumber(speed) || 0,
          derivedSpeed: sanitizeNumber(derivedSpeed) || 0,
          heading: Math.round(sanitizeNumber(heading) || 0),
          trackingActive: true,
          ...(routeInfo && {
            routeId: routeInfo.routeId,
            routeName: routeInfo.routeName,
            routeColor: routeInfo.routeColor,
            direction: routeInfo.direction,
            tripId: routeInfo.tripId,
            routeCoords: routeInfo.routeCoords || routeCoords || []
          }),
          // Include progression fields for live stop display (from progression engine)
          ...(progression && {
            snappedLat: sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
            snappedLng: sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
            isSnapped: progression.isSnapped || false,
            distanceFromRoute: sanitizeNumber(progression.distanceFromRoute) ?? null,
            currentStopId: progression.currentStopId ?? null,
            currentStopName: progression.currentStopName ?? null,
            nextStopId: progression.nextStopId ?? null,
            nextStopName: progression.nextStopName ?? null,
            passedStopIds: progression.passedStopIds || [],
            nextStopEtaMinutes: sanitizeNumber(progression.etaMinutes) ?? null,
            remainingDistanceMeters: sanitizeNumber(progression.remainingDistanceMeters) ?? null,
            routeProgressIndex: progression.currentStopIndex ?? -1,
            remainingDistanceKm: sanitizeNumber(progression.remainingDistanceKm) ?? null,
            progressPercent: sanitizeNumber(progression.progressPercent) ?? 0,
            avgSpeedKmh: sanitizeNumber(progression.avgSpeedKmh) ?? 0,
            gpsConfidence: progression.gpsConfidence || "UNKNOWN",
            gpsAccuracy: sanitizeNumber(progression.gpsAccuracy) ?? null
          })
        };
        
        // Safe payload serialization - prevents circular references and NaN
        const safePayload = JSON.parse(JSON.stringify(emitPayload));
        
        // Progression telemetry
        if (progression) {
          console.log("[PROGRESSION]", {
            busId,
            currentStopName: safePayload.currentStopName,
            nextStopName: safePayload.nextStopName,
            nextStopEtaMinutes: safePayload.nextStopEtaMinutes,
            routeProgressIndex: safePayload.routeProgressIndex
          });
        }

        // Emit telemetry
        console.log("[LOCATION]", "EMIT_PAYLOAD", {
          busId,
          isSnapped: !!progression,
          snappedLat: safePayload.snappedLat,
          currentStopId: safePayload.currentStopId,
          nextStopId: safePayload.nextStopId,
          etaMinutes: safePayload.nextStopEtaMinutes
        });

        console.log("[SPEED EMIT]", {
          busId,
          derivedSpeed: safePayload.derivedSpeed,
          speed: safePayload.speed,
        });

        console.log("[EMIT PAYLOAD]", {
          busId,
          currentStopName: safePayload.currentStopName,
          nextStopName: safePayload.nextStopName,
          nextStopEtaMinutes: safePayload.nextStopEtaMinutes,
          routeProgressIndex: safePayload.routeProgressIndex,
          isSnapped: safePayload.isSnapped,
        });

        console.log("[EMIT PREVIEW]", {
          busId,
          currentStopName: safePayload?.currentStopName,
          nextStopName: safePayload?.nextStopName,
          derivedSpeed: safePayload?.derivedSpeed,
          routeCoordsCount: safePayload?.routeCoords?.length,
          routeProgressIndex: safePayload?.routeProgressIndex,
        });

        console.log("[BACKEND] 📡 Emitting BUS_LOCATION_UPDATE:", safePayload);
        console.log("[ROUTE EMIT]", {
          busId: safePayload.busId,
          routeId: safePayload.routeId,
          routeName: safePayload.routeName,
          direction: safePayload.direction,
          tripId: safePayload.tripId,
        });

        console.log("[SOCKET PAYLOAD VERIFY]", {
          busId,
          hasRouteCoords: !!safePayload.routeCoords,
          coordsCount: safePayload.routeCoords?.length,
          currentStopName: safePayload.currentStopName,
          nextStopName: safePayload.nextStopName,
        });

        io.emit("BUS_LOCATION_UPDATE", safePayload);
        console.log("[BACKEND] ✅ Socket event emitted");
        
        // === EMIT PROGRESSION UPDATE (if changed) ===
        if (progression) {
          try {
            const prevProgression = trackingState.get(busId)?.progression;
            if (hasProgressionChanged(progression, prevProgression)) {
              const progressEmitPayload = {
                busId: busId.trim(),
                tripId: progression.tripId,
                routeId: progression.routeId,
                currentStopIndex: progression.currentStopIndex,
                nextStopIndex: progression.nextStopIndex,
                passedStopIds: progression.passedStopIds || [],
                remainingDistanceKm: sanitizeNumber(progression.remainingDistanceKm) ?? null,
                progressPercent: sanitizeNumber(progression.progressPercent) ?? null,
                etaMinutes: sanitizeNumber(progression.etaMinutes) ?? null,
                avgSpeedKmh: sanitizeNumber(progression.avgSpeedKmh) ?? null
              };
              
              // Safe serialization
              const safeProgressPayload = JSON.parse(JSON.stringify(progressEmitPayload));
              
              console.log("[BACKEND] 📡 Emitting BUS_PROGRESS_UPDATE:", safeProgressPayload);
              io.emit("BUS_PROGRESS_UPDATE", safeProgressPayload);
            } else {
              console.log("[BACKEND] ⏭️ Progression unchanged, skipping emit");
            }
          } catch (progressEmitError) {
            console.error("[BACKEND] ⚠️ Progress emit failed:", progressEmitError.message);
            // Non-fatal: continue tracking
          }
        }

        // === UPDATE + EMIT STOP ARRIVALS ===
        if (progression) {
          try {
            if (!progression.currentStopId && !progression.nextStopId) {
              console.log('[STOP ARRIVALS BLOCKED]', { busId, reason: 'NO_VALID_PROGRESSION' });
            } else {
              updateStopArrivals(busId, progression, routeForProgression, routeInfo);
              const arrivalsPayload = { stopArrivals: Object.fromEntries(stopArrivalsMap) };
              const safeArrivals = JSON.parse(JSON.stringify(arrivalsPayload));
              console.log('[STOP ARRIVALS] Emitting STOP_ARRIVALS_UPDATE, stops:', Object.keys(safeArrivals.stopArrivals).length);
              io.emit('STOP_ARRIVALS_UPDATE', safeArrivals);
            }
          } catch (arrivalsError) {
            console.error('[STOP ARRIVALS] Update failed:', arrivalsError.message);
          }
        }
      } else {
        console.log("[BACKEND] ⚠️ Socket emit skipped - invalid data");
      }
    } catch (emitError) {
      console.error("[BACKEND] ⚠️ Socket emit failed:", emitError.message);
      // Non-fatal: continue tracking even if emit fails
    }
    
    // FLOW TELEMETRY STEP 7: Before response
    console.log("[FLOW] STEP 7 - Before response");

    // === UPDATE TRACKING STATE ===
    // Merge with existing state to preserve route metadata
    const existingBus = trackingState.get(busId) || {};
    trackingState.set(busId, {
      ...existingBus, // Preserve existing fields (routeId, routeName, etc.)
      busId: busId.trim(),
      lat: numLat,
      lng: numLng,
      speed: speed, // Always use driver speed, no fallback
      derivedSpeed: derivedSpeed || 0,
      heading: Math.round(heading),
      lastUpdate: Date.now(),
      trackingActive: true,
      location: { latitude: numLat, longitude: numLng },
      ...(progression && {
        currentStopId: progression.currentStopId ?? null,
        currentStopName: progression.currentStopName ?? null,
        nextStopId: progression.nextStopId ?? null,
        nextStopName: progression.nextStopName ?? null,
        nextStopEtaMinutes: progression.etaMinutes ?? null,
        routeProgressIndex: progression.currentStopIndex ?? null,
        remainingDistanceMeters: progression.remainingDistanceMeters ?? null,
        passedStopIds: progression.passedStopIds || [],
        isSnapped: !!progression.lastProjectedPoint,
      }),
    });
    console.log("[BACKEND] ✅ State updated (MERGED):", busId, "speed:", Math.round(speed), "km/h", "route:", existingBus.routeId || "none");

    const updatedTrackingState = trackingState.get(busId);
    console.log("[TRACKING STATE VERIFY]", {
      busId,
      hasRouteCoords: !!updatedTrackingState?.routeCoords,
      coordsCount: updatedTrackingState?.routeCoords?.length,
      hasStops: !!updatedTrackingState?.stops,
      stopsCount: updatedTrackingState?.stops?.length,
      routeProgressIndex: updatedTrackingState?.routeProgressIndex,
      currentStopName: updatedTrackingState?.currentStopName,
      nextStopName: updatedTrackingState?.nextStopName,
    });
    
    // FLOW TELEMETRY STEP 8: Response sent
    console.log("[FLOW] STEP 8 - Response sent");
    
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
    
    const { busId, lat, lng, routeId, routeName, routeColor, direction } = req.body;
    
    console.log("[BACKEND START_TRACKING BODY]", { busId, routeId, routeName, routeColor, direction });
    if (!busId) {
      console.log("[BACKEND] ❌ Missing busId");
      return res.status(400).json({ error: "busId required" });
    }
    
    // Validate route if provided
    let routeData = null;
    let assignedRoute = null;
    
    if (routeId) {
      const route = routes.find(r => r.id === routeId);
      console.log("[ROUTE LOOKUP]", {
        requestedRouteId: routeId,
        found: !!route,
        hasCoords: !!(route?.routeCoords || route?.coordinates),
        coordsCount: (route?.routeCoords || route?.coordinates)?.length,
        hasStops: !!route?.stops,
        stopsCount: route?.stops?.length,
      });
      console.log("[ROUTE VERIFY]", {
        routeId: route?.id,
        keys: Object.keys(route || {}),
        hasRouteCoords: !!route?.routeCoords,
        coordsCount: route?.routeCoords?.length,
        hasStops: !!route?.stops,
        stopsCount: route?.stops?.length,
        firstStopType: typeof (route?.stops?.[0]),
      });
      if (!route) {
        console.log("[BACKEND] ❌ Invalid routeId:", routeId);
        return res.status(400).json({ error: "Invalid routeId" });
      }
      
      // Validate direction
      const validDirections = ["OUTBOUND", "INBOUND"];
      if (!direction || !validDirections.includes(direction)) {
        console.log("[BACKEND] ❌ Invalid direction:", direction);
        return res.status(400).json({ error: "Invalid direction. Must be OUTBOUND or INBOUND" });
      }
      
      // DEMO-SAFE: Build direction-specific stop sequence and route corridor
      // rawStops may be objects { stopId, name, lat, lng } (new schema) or string IDs (legacy schema)
      const rawStops = direction === "OUTBOUND"
        ? (route.stops || [])
        : (route.returnStops || [...(route.stops || [])].reverse());

      // Normalize to string IDs for progression engine compatibility
      const directionStops = rawStops.map(s =>
        (s !== null && typeof s === 'object') ? s.stopId : s
      );

      // Stop-position fallback: prefer object lat/lng, then Overpass lookup
      const { ALL_STOPS } = require("../services/overpassService");
      const stopPositionCoords = rawStops.map(s => {
        if (s !== null && typeof s === 'object') return [s.lat, s.lng];
        const found = ALL_STOPS.find(x => x.id === s);
        return found ? [found.lat, found.lng] : null;
      }).filter(Boolean);

      // Dense polyline: prefer routeCoords (new canonical schema) then coordinates (legacy schema)
      // INBOUND reverses the outbound polyline to match direction of travel
      const rawPolyline = direction === "INBOUND"
        ? [...(route.returnCoordinates || route.routeCoords || route.coordinates || [])].reverse()
        : (route.routeCoords || route.coordinates || []);
      const denseCoords = rawPolyline.length >= 2 ? rawPolyline : stopPositionCoords;

      if (!denseCoords?.length || denseCoords.length < 2) {
        console.error("[TRACKING START] Missing routeCoords", { routeId });
        return res.status(400).json({
          success: false,
          message: "Route missing routeCoords",
        });
      }

      routeData = {
        routeId: route.id,
        routeName: routeName || route.name,
        routeColor: routeColor || route.color,
        direction: direction,
        stops: directionStops,
        routeCoords: denseCoords
      };

      console.log("[ROUTE HYDRATION]", {
        routeId: route.id,
        routeName: route.name,
        direction,
        routeCoordsCount: denseCoords.length,
        stopsCount: directionStops.length,
        hasRouteCoordinates: denseCoords.length > 0,
        hasStops: directionStops.length > 0,
        source: rawPolyline.length >= 2 ? "dense_polyline" : "stop_positions",
      });

      // Alignment check: coords and stops must be same length for index-based matching
      console.log("[ROUTE HYDRATION CHECK]", {
        direction,
        routeCoordsCount: denseCoords.length,
        stopsCount: directionStops.length,
        aligned: denseCoords.length === directionStops.length,
        firstCoord: denseCoords[0] || null,
        firstStop: directionStops[0]
          ? (getStopNameById(directionStops[0]) || directionStops[0])
          : null,
        lastCoord: denseCoords[denseCoords.length - 1] || null,
        lastStop: directionStops[directionStops.length - 1]
          ? (getStopNameById(directionStops[directionStops.length - 1]) || directionStops[directionStops.length - 1])
          : null,
      });

      console.log("[BACKEND] Route validated:", route.name, "-", direction, "Stops:", directionStops.length);
    }
    
    console.log("[BACKEND] Initializing tracking state for:", busId);
    setTrackingActive(busId, true);
    
    // Assign route if provided
    if (routeData) {
      assignedRoute = setBusRoute(busId, routeData);
      console.log("[BACKEND] Route assigned:", assignedRoute.tripId);

      // Fix 1: Explicitly consolidate routeCoords + stops into trackingState
      // Defensive merge — survives any intermediate state wipe between setTrackingActive and here
      const consolidatedBase = trackingState.get(busId) || {};
      trackingState.set(busId, {
        ...consolidatedBase,
        routeCoords: routeData.routeCoords,
        stops: routeData.stops,
        passedStopIds: consolidatedBase.passedStopIds || [],
        routeProgressIndex: 0,
        lastUpdate: Date.now(),
      });

      const postHydration = trackingState.get(busId);
      console.log("[TRACKING STATE VERIFY]", {
        busId,
        hasRouteCoords: !!postHydration?.routeCoords,
        coordsCount: postHydration?.routeCoords?.length,
        hasStops: !!postHydration?.stops,
        stopsCount: postHydration?.stops?.length,
        routeProgressIndex: postHydration?.routeProgressIndex,
        currentStopName: postHydration?.currentStopName,
        nextStopName: postHydration?.nextStopName,
      });
    }
    
    // Verify tracking state storage
    const storedState = trackingState.get(busId);
    console.log("[TRACKING STATE STORED]", {
      busId,
      routeId: storedState?.routeId,
      routeName: storedState?.routeName,
      routeColor: storedState?.routeColor,
      direction: storedState?.direction,
      tripId: storedState?.tripId,
    });
    
    const io = req.app.get("io");
    
    // Immediately emit BUS_LOCATION_UPDATE if location provided
    if (io && busId && lat != null && lng != null) {
      const numLat = Number(lat);
      const numLng = Number(lng);
      if (Number.isFinite(numLat) && Number.isFinite(numLng)) {
        const emitPayload = {
          busId: busId.trim(),
          latitude: numLat,
          longitude: numLng,
          trackingActive: true,
          lastUpdate: Date.now(),
          ...(assignedRoute && {
            routeId: assignedRoute.routeId,
            routeName: assignedRoute.routeName,
            routeColor: assignedRoute.routeColor,
            direction: assignedRoute.direction,
            tripId: assignedRoute.tripId,
            routeCoords: routeData?.routeCoords || [],
            stops: routeData?.stops || []
          })
        };
        console.log("[BACKEND] 📡 Emitting BUS_LOCATION_UPDATE on start:", emitPayload);
        console.log("[BACKEND] BUS_LOCATION_UPDATE emitted for bus:", busId);
        console.log("[ROUTE EMIT]", {
          busId: emitPayload.busId,
          routeId: emitPayload.routeId,
          routeName: emitPayload.routeName,
          direction: emitPayload.direction,
          tripId: emitPayload.tripId,
        });
        io.emit("BUS_LOCATION_UPDATE", emitPayload);
      }
    }
    
    const newState = trackingState.get(busId);
    console.log("[BACKEND] ✅ Tracking started:", busId, "State:", newState);
    
    return res.json({ 
      success: true, 
      message: "Tracking started", 
      busId,
      ...(assignedRoute && {
        tripId: assignedRoute.tripId,
        routeName: assignedRoute.routeName,
        direction: assignedRoute.direction
      })
    });
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

// Debug endpoint for progression diagnostics
const debugProgression = async (req, res) => {
  try {
    const { busId } = req.params;
    console.log("[DEBUG] ========== PROGRESSION DEBUG ==========");
    console.log("[DEBUG] busId:", busId);

    // Get tracking state
    const state = trackingState.get(busId);
    if (!state) {
      return res.status(404).json({
        error: "Bus not found or not tracking",
        busId,
        trackingState: null
      });
    }

    // Get route info
    const routeId = state.routeId;
    const route = routes.find(r => r.id === routeId);

    // Get raw route coordinates
    const rawRouteCoords = route?.routeCoords || route?.coordinates || [];

    // Normalize coordinates
    const normalizedCoords = rawRouteCoords.map(toLatLng).filter(Boolean);

    // Get stops
    const rawStops = route?.stops || [];
    const normalizedStops = rawStops.map(stopId => {
      const stop = ALL_STOPS.find(s => s.id === stopId);
      return stop ? { id: stopId, ...stop } : null;
    }).filter(Boolean);

    // Get current progression
    const progression = getBusProgression(busId);

    // Get last known location
    const lastLocation = state.location || state.lastLocation || null;

    // Try projection if we have location and coords
    let projectionResult = null;
    let snappedPoint = null;
    if (lastLocation && normalizedCoords.length >= 2) {
      try {
        projectionResult = projectOntoRouteCorridor(
          lastLocation.lat,
          lastLocation.lng,
          normalizedCoords,
          busId
        );
        snappedPoint = projectionResult?.projectedPoint || null;
      } catch (projErr) {
        projectionResult = { error: projErr.message };
      }
    }

    // Build debug response
    const debugInfo = {
      busId,
      timestamp: new Date().toISOString(),
      trackingState: {
        trackingActive: state.trackingActive,
        routeId: state.routeId,
        routeName: state.routeName,
        tripId: state.tripId,
        lastUpdate: state.lastUpdate,
        hasLocation: !!lastLocation,
        lastLocation: lastLocation ? {
          lat: lastLocation.lat,
          lng: lastLocation.lng,
          timestamp: lastLocation.timestamp
        } : null
      },
      route: {
        routeId,
        routeName: route?.name || null,
        rawCoordsLength: rawRouteCoords.length,
        normalizedCoordsLength: normalizedCoords.length,
        coordsSample: normalizedCoords.slice(0, 3).map(c => ({ lat: c.lat, lng: c.lng })),
        firstCoord: normalizedCoords[0] || null,
        lastCoord: normalizedCoords[normalizedCoords.length - 1] || null,
        stopsCount: rawStops.length,
        normalizedStopsCount: normalizedStops.length,
        stopsSample: normalizedStops.slice(0, 3).map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
      },
      projection: projectionResult ? {
        hasProjection: !!projectionResult.projectedPoint,
        projectedPoint: projectionResult.projectedPoint || null,
        distanceFromCorridor: projectionResult.distanceFromCorridor || null,
        segmentIndex: projectionResult.segmentIndex || null,
        cumulativeDistance: projectionResult.cumulativeDistance || null,
        totalRouteLength: projectionResult.totalRouteLength || null,
        error: projectionResult.error || null
      } : null,
      snappedCoordinates: snappedPoint ? {
        lat: snappedPoint.lat,
        lng: snappedPoint.lng
      } : null,
      progression: progression || null,
      coordinateOrder: {
        note: "All coordinates normalized to {lat, lng} format",
        backendRouteCoordsFormat: rawRouteCoords.length > 0 ?
          (Array.isArray(rawRouteCoords[0]) ?
            (Math.abs(rawRouteCoords[0][0]) <= 90 ? "[lat, lng]" : "[lng, lat]") :
            "object format") : "N/A"
      }
    };

    console.log("[DEBUG] Response:", JSON.stringify(debugInfo, null, 2));
    return res.json(debugInfo);
  } catch (err) {
    console.error("[DEBUG] ERROR:", err.message);
    return res.status(500).json({
      error: "Debug endpoint failed",
      message: err.message,
      stack: err.stack
    });
  }
};

module.exports = {
  updateLocation,
  getAllBusLocations,
  getNearestStopHandler,
  getNearestSingleBus,
  startTracking,
  stopTracking,
  debugProgression
};
