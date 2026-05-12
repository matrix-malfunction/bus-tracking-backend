/**
 * Bus Stop Progression Engine
 * 
 * Backend-driven progression calculation with GPS jitter protection.
 * Projects bus position onto route corridor and computes stop progression.
 */

const routes = require("../../data/routes");
const { DEMO_STOP_METADATA = {} } = routes;
const { getBusProgression, setBusProgression, addSpeedSample, getRollingAverageSpeed, getTrackingState } = require("./trackingState");
const { getStopNameById, ALL_STOPS } = require("../services/overpassService");

// Hysteresis thresholds
const MIN_ADVANCEMENT_METERS = 50; // Must advance 50m before updating stop index
const GPS_JITTER_THRESHOLD_METERS = 15; // Unified threshold: ignore movements less than 15m
const MIN_SPEED_KMH = 5; // Minimum operational speed for ETA calculation

// STOP ARRIVAL DETECTION thresholds
const STOP_ARRIVAL_THRESHOLD_METERS = 40; // Bus must be within 40m to be "at" stop
const STOP_ADVANCE_HYSTERESIS_METERS = 60; // Must advance 60m past stop to move to next
const ARRIVAL_THRESHOLD_METERS = 60; // Demo fallback: only advance stop index when within 60m of target stop
const MAX_USABLE_ACCURACY_METERS = 80; // Maximum GPS accuracy we can use for progression

// ROUTE SNAPPING thresholds
const ROUTE_SNAP_THRESHOLD_METERS = 100; // Maximum distance from route to snap (otherwise use raw GPS)
const ROUTE_SNAP_MAX_DISTANCE_METERS = 150; // Hard cutoff - beyond this, no snapping at all

/**
 * HARD COORDINATE NORMALIZER
 * Auto-detects coordinate order and validates ranges
 * Handles GeoJSON [lng, lat] and [lat, lng] formats
 */
function normalizeCoord(coord, index = 0) {
  if (!coord) return null;

  // Object format {lat,lng}
  if (
    typeof coord === "object" &&
    !Array.isArray(coord) &&
    coord.lat !== undefined &&
    coord.lng !== undefined
  ) {
    const lat = Number(coord.lat);
    const lng = Number(coord.lng);

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return { lat, lng };
    }

    console.log("[COORD INVALID] Object format out of range", { index, lat, lng });
    return null;
  }

  // MongoDB / GeoJSON object {latitude, longitude}
  if (
    typeof coord === "object" &&
    !Array.isArray(coord) &&
    typeof coord.latitude !== "undefined" &&
    typeof coord.longitude !== "undefined"
  ) {
    const lat = Number(coord.latitude);
    const lng = Number(coord.longitude);

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return { lat, lng };
    }

    console.log("[COORD INVALID] MongoDB format out of range", { index, lat, lng });
    return null;
  }

  // Array format - auto-detect order
  if (Array.isArray(coord) && coord.length >= 2) {
    const a = Number(coord[0]);
    const b = Number(coord[1]);

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      console.log("[COORD INVALID] Non-numeric values", { index, a, b });
      return null;
    }

    // Auto-detect: [lng, lat] (GeoJSON) vs [lat, lng] (common)
    // lat range: -90 to 90
    // lng range: -180 to 180
    const aIsLat = Math.abs(a) <= 90;
    const bIsLat = Math.abs(b) <= 90;
    const aIsLng = Math.abs(a) <= 180;
    const bIsLng = Math.abs(b) <= 180;

    if (aIsLat && bIsLng) {
      // [lat, lng] format
      return { lat: a, lng: b };
    }

    if (bIsLat && aIsLng) {
      // [lng, lat] format (GeoJSON standard)
      return { lat: b, lng: a };
    }

    // Both in valid range - ambiguous, prefer [lat, lng] for consistency
    if (aIsLat && aIsLng && bIsLat && bIsLng) {
      console.log("[COORD AMBIGUOUS] Both values in valid range", { index, a, b, assumed: "[lat, lng]" });
      return { lat: a, lng: b };
    }

    console.log("[COORD INVALID] Values out of valid range", { index, a, b, aIsLat, bIsLng });
    return null;
  }

  console.log("[COORD INVALID] Unrecognized format", { index, type: typeof coord, isArray: Array.isArray(coord) });
  return null;
}

// STOP EVENT ENGINE
// Per-bus stop event state for lifecycle tracking (APPROACHING -> ARRIVED -> DWELLING -> DEPARTED)
const stopEventState = new Map();

// ETA STATE
const etaState = new Map();

/**
 * Normalize coordinate to {lat, lng} format (universal converter)
 * Supports: {lat,lng}, {latitude,longitude}, [lat,lng], [lng,lat], {x,y}
 * Returns null if invalid
 */
function toLatLng(coord) {
  if (!coord) return null;
  
  // Object format: {lat, lng}, {latitude, longitude}, {x, y}
  if (typeof coord === 'object' && !Array.isArray(coord)) {
    const lat = coord.lat ?? coord.latitude ?? coord.y ?? null;
    const lng = coord.lng ?? coord.longitude ?? coord.x ?? coord.lon ?? null;
    if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }
  
  // Array format: [lat, lng] or [lng, lat]
  if (Array.isArray(coord) && coord.length >= 2) {
    const [a, b] = coord;
    if (typeof a !== 'number' || typeof b !== 'number') return null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    
    // Detect format by valid ranges
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b }; // [lat, lng]
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return { lat: b, lng: a };  // [lng, lat]
    
    // Fallback: assume [lat, lng] if both in reasonable range
    return { lat: a, lng: b };
  }
  
  return null;
}

/**
 * Safe number converter - returns null for NaN/Infinity
 */
function safeNumber(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Create safe fallback progression object
 * Used when progression computation fails but tracking must continue
 */
function createFallbackProgression(busId, gpsConfidence, gpsAccuracy) {
  return {
    busId,
    isSnapped: false,
    currentStopIndex: -1,
    currentStopId: null,
    currentStopName: null,
    nextStopIndex: -1,
    nextStopId: null,
    nextStopName: null,
    passedStopIds: [],
    remainingDistanceKm: 0,
    remainingDistanceMeters: null,
    progressPercent: 0,
    etaMinutes: null,
    avgSpeedKmh: 0,
    cumulativeDistance: 0,
    totalRouteLength: 0,
    lastProjectedPoint: null,
    lastUpdate: Date.now(),
    jitterFiltered: false,
    gpsConfidence: gpsConfidence ?? "UNKNOWN",
    gpsAccuracy: gpsAccuracy ?? null,
    fallback: true // Mark as fallback for debugging
  };
}

// Event callback registry - external consumers register here
const eventCallbacks = [];

/**
 * Register a callback for stop events
 * @param {Function} callback - function(eventType, payload)
 */
function onStopEvent(callback) {
  eventCallbacks.push(callback);
}

/**
 * Emit a stop event to all registered callbacks
 * @param {string} eventType - ARRIVED, DEPARTED, DWELLING, APPROACHING
 * @param {object} payload - event data
 */
function emitStopEvent(eventType, payload) {
  console.log(`[STOP EVENT] ${eventType}:`, payload);
  eventCallbacks.forEach(cb => {
    try {
      cb(eventType, payload);
    } catch (err) {
      console.error("[STOP EVENT] Callback error:", err.message);
    }
  });
}

/**
 * Get or initialize ETA state for a bus
 * @param {string} busId - Bus identifier
 * @returns {object} - ETA state
 */
function getEtaState(busId) {
  if (!etaState.has(busId)) {
    etaState.set(busId, {
      rollingSpeedKmh: 20, // Default 20 km/h
      lastEtaMinutes: null,
      lastEtaTime: null,
      nextStopId: null,
      hasApproached: new Map() // Track which stops we've approached
    });
  }
  return etaState.get(busId);
}

/**
 * Compute stable ETA with rolling speed smoothing
 * @param {string} busId - Bus identifier
 * @param {number} nextStopId - Next stop ID
 * @param {number} remainingDistanceMeters - Distance to next stop in meters
 * @param {number} currentSpeedKmh - Current speed from GPS
 * @returns {{etaMinutes: number, remainingDistanceMeters: number}} - ETA calculation
 */
function computeEta(busId, nextStopId, remainingDistanceMeters, currentSpeedKmh) {
  const state = getEtaState(busId);
  
  // Update rolling speed with smoothing (ignore very slow speeds < 3 km/h)
  let effectiveSpeed = currentSpeedKmh;
  if (currentSpeedKmh < 3) {
    effectiveSpeed = state.rollingSpeedKmh; // Use last known rolling speed
  }
  
  // Rolling average: 80% old + 20% new (smoother ETA)
  state.rollingSpeedKmh = (state.rollingSpeedKmh * 0.8) + (effectiveSpeed * 0.2);
  
  // Minimum speed for ETA calculation (avoid infinite ETA when stopped)
  const minSpeedForEta = 5; // 5 km/h minimum
  const speedForEta = Math.max(state.rollingSpeedKmh, minSpeedForEta);
  
  // Calculate ETA in minutes
  // distance (m) / (speed (km/h) * 1000 / 60) = minutes
  let etaMinutes = (remainingDistanceMeters / 1000) / (speedForEta / 60);
  
  // Clamp ETA to reasonable range
  etaMinutes = Math.max(1, Math.min(120, Math.round(etaMinutes)));
  
  // Reset approach tracking if next stop changed
  if (state.nextStopId !== nextStopId) {
    state.nextStopId = nextStopId;
    state.hasApproached = new Map();
  }
  
  return {
    etaMinutes,
    remainingDistanceMeters: Math.round(remainingDistanceMeters),
    rollingSpeedKmh: Math.round(state.rollingSpeedKmh * 10) / 10
  };
}

/**
 * Check for APPROACHING event (within 2 minutes of stop)
 * @param {string} busId - Bus identifier
 * @param {string} nextStopId - Next stop ID
 * @param {number} etaMinutes - Current ETA
 * @param {string} nextStopName - Name of next stop
 */
function checkApproachingEvent(busId, nextStopId, etaMinutes, nextStopName) {
  if (!nextStopId || etaMinutes > 2) return; // Not approaching yet
  
  const state = getEtaState(busId);
  
  // Event lock: only emit APPROACHING once per stop
  if (state.hasApproached.has(nextStopId)) return;
  
  // Mark as approached
  state.hasApproached.set(nextStopId, true);
  
  emitStopEvent('APPROACHING', {
    busId,
    stopId: nextStopId,
    stopName: nextStopName,
    etaMinutes,
    approachedAt: Date.now()
  });
}

/**
 * Get or initialize stop event state for a bus
 * @param {string} busId - Bus identifier
 * @returns {object} - stop event state
 */
function getStopEventState(busId) {
  if (!stopEventState.has(busId)) {
    stopEventState.set(busId, {
      currentStopId: null,
      status: null, // APPROACHING, ARRIVED, DWELLING, DEPARTED
      arrivedAt: null,
      departedAt: null,
      dwellSeconds: 0,
      lastEventStopId: null,
      lastEventType: null
    });
  }
  return stopEventState.get(busId);
}

/**
 * Update stop event state based on current progression
 * Detects ARRIVAL, DWELLING, and DEPARTURE lifecycle events
 * @param {string} busId - Bus identifier
 * @param {object} progression - Current progression state
 * @param {number} distanceToStop - Distance to current stop in meters
 * @param {number} effectiveArrivalThreshold - Dynamic threshold based on GPS accuracy
 * @param {number} effectiveHysteresis - Hysteresis threshold
 */
function updateStopEventState(busId, progression, distanceToStop, effectiveArrivalThreshold, effectiveHysteresis) {
  const state = getStopEventState(busId);
  const currentStopId = progression?.currentStopId;
  const now = Date.now();
  
  // No current stop - bus is between stops
  if (!currentStopId) {
    // If we were at a stop and now we're not, emit DEPARTED
    if (state.status === 'ARRIVED' || state.status === 'DWELLING') {
      const dwellSeconds = state.arrivedAt ? Math.round((now - state.arrivedAt) / 1000) : 0;
      
      emitStopEvent('DEPARTED', {
        busId,
        stopId: state.currentStopId,
        stopName: getSafeStopName({ stopId: state.currentStopId }),
        dwellSeconds,
        departedAt: now
      });
      
      // Update state
      state.status = 'DEPARTED';
      state.departedAt = now;
      state.dwellSeconds = dwellSeconds;
      state.lastEventStopId = state.currentStopId;
      state.lastEventType = 'DEPARTED';
      state.currentStopId = null;
    }
    return;
  }
  
  // New stop detected - different from previous
  const isNewStop = state.currentStopId !== currentStopId;
  
  // Check for departure from previous stop (different stop or distance exceeds hysteresis)
  if (state.currentStopId && state.currentStopId !== currentStopId && 
      (state.status === 'ARRIVED' || state.status === 'DWELLING')) {
    // Emit DEPARTED for previous stop
    const dwellSeconds = state.arrivedAt ? Math.round((now - state.arrivedAt) / 1000) : 0;
    
    emitStopEvent('DEPARTED', {
      busId,
      stopId: state.currentStopId,
      stopName: getSafeStopName({ stopId: state.currentStopId }),
      dwellSeconds,
      departedAt: now,
      nextStopId: currentStopId
    });
    
    state.status = 'DEPARTED';
    state.departedAt = now;
    state.dwellSeconds = dwellSeconds;
    state.lastEventStopId = state.currentStopId;
    state.lastEventType = 'DEPARTED';
  }
  
  // ARRIVAL detection: within threshold AND either new stop or was approaching
  if (distanceToStop <= effectiveArrivalThreshold) {
    // Check event lock - prevent re-emitting ARRIVED for same stop
    const alreadyArrivedHere = state.lastEventStopId === currentStopId && 
                               state.lastEventType === 'ARRIVED';
    
    if (!alreadyArrivedHere && (isNewStop || !state.status || state.status === 'DEPARTED')) {
      // New arrival
      emitStopEvent('ARRIVED', {
        busId,
        stopId: currentStopId,
        stopName: getSafeStopName({ stopId: currentStopId }),
        distance: Math.round(distanceToStop),
        threshold: effectiveArrivalThreshold,
        arrivedAt: now
      });
      
      state.currentStopId = currentStopId;
      state.status = 'ARRIVED';
      state.arrivedAt = now;
      state.departedAt = null;
      state.dwellSeconds = 0;
      state.lastEventStopId = currentStopId;
      state.lastEventType = 'ARRIVED';
    } else if (state.status === 'ARRIVED' || state.status === 'DWELLING') {
      // Still at stop - update to DWELLING after 5 seconds
      const dwellSeconds = state.arrivedAt ? Math.round((now - state.arrivedAt) / 1000) : 0;
      
      if (dwellSeconds >= 5 && state.status !== 'DWELLING') {
        emitStopEvent('DWELLING', {
          busId,
          stopId: currentStopId,
          stopName: getSafeStopName({ stopId: currentStopId }),
          dwellSeconds,
          updatedAt: now
        });
        
        state.status = 'DWELLING';
        state.dwellSeconds = dwellSeconds;
      } else if (state.status === 'DWELLING') {
        // Update dwell time while dwelling
        state.dwellSeconds = dwellSeconds;
      }
    }
  } else if (distanceToStop > effectiveHysteresis && state.currentStopId === currentStopId) {
    // DEPARTURE detection: moved past hysteresis threshold
    if (state.status === 'ARRIVED' || state.status === 'DWELLING') {
      const dwellSeconds = state.arrivedAt ? Math.round((now - state.arrivedAt) / 1000) : 0;
      
      emitStopEvent('DEPARTED', {
        busId,
        stopId: currentStopId,
        stopName: getSafeStopName({ stopId: currentStopId }),
        dwellSeconds,
        distance: Math.round(distanceToStop),
        departedAt: now
      });
      
      state.status = 'DEPARTED';
      state.departedAt = now;
      state.dwellSeconds = dwellSeconds;
      state.lastEventStopId = currentStopId;
      state.lastEventType = 'DEPARTED';
    }
    
    // Update to APPROACHING for next stop
    if (!state.status || state.status === 'DEPARTED') {
      state.status = 'APPROACHING';
      state.currentStopId = currentStopId;
      
      emitStopEvent('APPROACHING', {
        busId,
        stopId: currentStopId,
        stopName: getSafeStopName({ stopId: currentStopId }),
        distance: Math.round(distanceToStop),
        threshold: effectiveArrivalThreshold
      });
    }
  }
}

/**
 * Calculate GPS confidence level based on accuracy
 * @param {number} accuracy - GPS accuracy in meters
 * @returns {string} - HIGH / MEDIUM / LOW / UNUSABLE
 */
function getGpsConfidence(accuracy) {
  if (!accuracy || accuracy <= 20) return "HIGH";
  if (accuracy <= 40) return "MEDIUM";
  if (accuracy <= MAX_USABLE_ACCURACY_METERS) return "LOW";
  return "UNUSABLE";
}

// Build stop coordinate lookup map.
// Curated DEMO_STOP_METADATA is merged LAST so it wins on any ID conflict with Overpass data.
const STOP_COORDS_MAP = new Map([
  ...ALL_STOPS.map(stop => [String(stop.id), { lat: stop.lat, lng: stop.lng }]),
  ...Object.entries(DEMO_STOP_METADATA).map(([id, s]) => [id, { lat: s.lat, lng: s.lng }]),
]);

/**
 * Get stop coordinates by ID
 * @param {string} stopId - Stop identifier
 * @returns {{lat: number, lng: number} | null}
 */
function getStopCoordsById(stopId) {
  if (!stopId) return null;
  return STOP_COORDS_MAP.get(String(stopId)) || null;
}

function getSafeStopId(stop) {
  return typeof stop === "string"
    ? stop
    : (stop?.stopId || stop?.id || stop?._id || null);
}

function getSafeStopName(stop) {
  const safeStopId = getSafeStopId(stop);
  return getStopNameById(safeStopId) || DEMO_STOP_METADATA[safeStopId]?.name || stop?.name || "Unknown Stop";
}

/**
 * Snap GPS coordinates to nearest route corridor segment
 * Returns snapped position only if within threshold, otherwise returns null
 * @param {number} lat - Raw GPS latitude
 * @param {number} lng - Raw GPS longitude
 * @param {Array} routeCoords - Route coordinates [[lat, lng], ...]
 * @returns {{snappedLat: number, snappedLng: number, distanceFromRoute: number} | null}
 */
function snapToRouteCorridor(lat, lng, routeCoords) {
  // Defensive validation - never throw, always return null on invalid input
  if (!routeCoords || !Array.isArray(routeCoords) || routeCoords.length < 2) {
    console.log("[SNAP DEBUG] Invalid routeCoords:", routeCoords);
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.log("[SNAP DEBUG] Invalid GPS coords:", lat, lng);
    return null;
  }
  
  // ROUTE FORMAT DIAGNOSTIC
  console.log("[SNAP DEBUG] Bus GPS:", { lat, lng, routePoints: routeCoords.length });
  console.log("[ROUTE FORMAT] First coordinate:", routeCoords[0]);
  console.log("[ROUTE FORMAT] Last coordinate:", routeCoords[routeCoords.length - 1]);
  
  let minDistance = Infinity;
  let snappedPoint = null;
  let snappedSegmentIndex = -1;
  let bestSegmentStart = null;
  let bestSegmentEnd = null;
  
  // Find nearest segment with defensive validation
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const start = toLatLng(routeCoords[i]);
    const end = toLatLng(routeCoords[i + 1]);
    
    // Skip invalid segments
    if (!start || !end) {
      continue;
    }
    
    // Defensive: catch any math errors in projection
    let projection = null;
    try {
      projection = projectPointOntoSegment(
        { lat, lng },
        start,
        end
      );
    } catch (err) {
      // Skip this segment if projection fails
      continue;
    }
    
    if (projection && projection.point && projection.distance < minDistance && 
        Number.isFinite(projection.distance) &&
        Number.isFinite(projection.point.lat) &&
        Number.isFinite(projection.point.lng)) {
      minDistance = projection.distance;
      snappedPoint = projection.point;
      snappedSegmentIndex = i;
      bestSegmentStart = start;
      bestSegmentEnd = end;
    }
  }
  
  // Log best segment found (or null if none)
  console.log("[SNAP SEGMENT] Best segment:", {
    index: snappedSegmentIndex,
    start: bestSegmentStart,
    end: bestSegmentEnd,
    distance: minDistance === Infinity ? null : Math.round(minDistance),
    snappedPoint: snappedPoint
  });
  
  // Validate final snapped coordinates before returning
  if (!snappedPoint || !snappedPoint.lat || !snappedPoint.lng) {
    console.log("[SNAP RESULT] No valid snapped point found");
    return null;
  }
  const snappedLat = snappedPoint.lat;
  const snappedLng = snappedPoint.lng;
  if (!Number.isFinite(snappedLat) || !Number.isFinite(snappedLng)) {
    console.log("[SNAP RESULT] Snapped coordinates non-finite:", snappedLat, snappedLng);
    return null;
  }
  
  // Hard cutoff: beyond 150m, no snapping at all
  if (minDistance > ROUTE_SNAP_MAX_DISTANCE_METERS) {
    console.log("[SNAP RESULT] Distance exceeds max threshold:", Math.round(minDistance), ">", ROUTE_SNAP_MAX_DISTANCE_METERS);
    return null;
  }
  
  // Soft threshold: within 100m, return snapped coordinates
  // Between 100-150m, still snap but with warning flag (for debugging)
  if (minDistance <= ROUTE_SNAP_THRESHOLD_METERS) {
    const result = {
      snappedLat: snappedPoint.lat,
      snappedLng: snappedPoint.lng,
      distanceFromRoute: minDistance,
      isSnapped: true,
      segmentIndex: snappedSegmentIndex
    };
    console.log("[SNAP RESULT] HARD SNAP:", {
      snappedLat: result.snappedLat,
      snappedLng: result.snappedLng,
      distanceFromRoute: Math.round(result.distanceFromRoute)
    });
    return result;
  }
  
  // Soft snap: between 100-150m
  if (minDistance <= ROUTE_SNAP_MAX_DISTANCE_METERS) {
    const result = {
      snappedLat: snappedPoint.lat,
      snappedLng: snappedPoint.lng,
      distanceFromRoute: minDistance,
      isSnapped: true,
      isSoftSnap: true,
      segmentIndex: snappedSegmentIndex
    };
    console.log("[SNAP RESULT] SOFT SNAP:", {
      snappedLat: result.snappedLat,
      snappedLng: result.snappedLng,
      distanceFromRoute: Math.round(result.distanceFromRoute)
    });
    return result;
  }
  
  console.log("[SNAP RESULT] No snap - distance too far:", Math.round(minDistance));
  return null;
}

/**
 * Calculate distance between two points using Haversine formula
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  // Validate all inputs
  if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
    return Infinity;
  }
  
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const result = R * c;
  
  // Guard against NaN
  return Number.isFinite(result) ? result : Infinity;
}

/**
 * Demo-safe distance helper
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find nearest point on a line segment
 * Returns: { point: {lat, lng}, distance: meters, segmentIndex: number }
 */
function projectPointOntoSegment(point, segmentStart, segmentEnd) {
  // Normalize inputs to {lat, lng}
  const p = toLatLng(point);
  const start = toLatLng(segmentStart);
  const end = toLatLng(segmentEnd);
  
  if (!p || !start || !end) {
    return { point: null, distance: Infinity, t: 0 };
  }
  
  const px = p.lng;
  const py = p.lat;
  const x1 = start.lng;
  const y1 = start.lat;
  const x2 = end.lng;
  const y2 = end.lat;
  
  // Convert to local meters approximation
  const latAvg = (y1 + y2) / 2;
  const latScale = Math.cos(latAvg * Math.PI / 180) * 111320;
  const lngScale = 111320;
  
  // Vector from segment start to end
  const dx = (x2 - x1) * latScale;
  const dy = (y2 - y1) * lngScale;
  
  // Vector from segment start to point
  const dpx = (px - x1) * latScale;
  const dpy = (py - y1) * lngScale;
  
  // Project point onto line
  const dot = dpx * dx + dpy * dy;
  const lenSq = dx * dx + dy * dy;
  
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, dot / lenSq));
  }
  
  // Calculate projected point
  const projLat = y1 + t * (y2 - y1);
  const projLng = x1 + t * (x2 - x1);
  
  // Guard against NaN
  if (!Number.isFinite(projLat) || !Number.isFinite(projLng)) {
    return { point: null, distance: Infinity, t: 0 };
  }
  
  // Calculate distance from point to projection
  const distance = haversineDistance(py, px, projLat, projLng);
  
  return {
    point: { lat: projLat, lng: projLng },
    distance: Number.isFinite(distance) ? distance : Infinity,
    t // Parameter along segment (0-1)
  };
}

/**
 * Project GPS position onto route corridor
 * Returns: { projectedPoint, cumulativeDistance, segmentIndex, distanceFromCorridor }
 */
function projectOntoRouteCorridor(busLat, busLng, routeCoordinates, busId = "unknown") {
  console.log("[CORRIDOR INPUT]", {
    point: { lat: busLat, lng: busLng },
    routePoints: routeCoordinates?.length,
    threshold: 250,
  });

  // VALIDATE BUS LOCATION
  if (!Number.isFinite(busLat) || !Number.isFinite(busLng)) {
    console.error("[CORRIDOR FAILED]", "INVALID_BUS_LOCATION", { busLat, busLng });
    return null;
  }

  // HARD NORMALIZE route coordinates
  const normalizedRoute = routeCoordinates.map((c, i) => normalizeCoord(c, i)).filter(Boolean);

  console.log("[NORMALIZED ROUTE SAMPLE]", normalizedRoute.slice(0, 5));

  // ROUTE VALIDATION with telemetry (keep for mismatch detection)
  const originalCount = routeCoordinates?.length || 0;
  const normalizedCount = normalizedRoute.length;
  if (normalizedCount < 2) {
    console.error("[CORRIDOR FAILED]", "NO_ROUTE_POINTS", { originalCount, normalizedCount });
    return null;
  }
  if (normalizedCount !== originalCount) {
    console.warn("[ROUTE VALIDATION] Mismatch", { originalCount, normalizedCount });
  }

  let minDistance = Infinity;
  let bestProjection = null;
  let cumulativeDistance = 0;
  let bestSegmentIndex = 0;
  let segmentStartDistance = 0;

  // HARDENED SEGMENT LOOP
  for (let i = 0; i < normalizedRoute.length - 1; i++) {
    const start = normalizedRoute[i];
    const end = normalizedRoute[i + 1];

    console.log("[SEGMENT CHECK]", {
      index: i,
      start,
      end,
    });

    if (!start || !end) {
      console.log("[CORRIDOR FAILED]", "INVALID_COORDINATES", { start, end, index: i });
      continue;
    }

    // Hard validate segment coordinates before geometry math
    if (
      Number.isNaN(start.lat) ||
      Number.isNaN(start.lng) ||
      Number.isNaN(end.lat) ||
      Number.isNaN(end.lng)
    ) {
      console.log("[INVALID ROUTE SEGMENT]", { start, end, index: i });
      continue;
    }

    const projection = projectPointOntoSegment(
      { lat: busLat, lng: busLng },
      start,
      end
    );

    console.log("[SEGMENT DISTANCE]", {
      segmentIndex: i,
      distanceMeters: projection?.distance,
    });

    if (projection.distance < minDistance) {
      minDistance = projection.distance;
      bestProjection = projection;
      bestSegmentIndex = i;
      segmentStartDistance = cumulativeDistance;
    }

    // Add segment length to cumulative
    const segmentLength = haversineDistance(
      start.lat, start.lng,
      end.lat, end.lng
    );
    cumulativeDistance += segmentLength;
  }

  console.log("[BEST PROJECTION]", {
    minDistance,
    bestSegmentIndex,
    snappedLat: bestProjection?.point?.lat,
    snappedLng: bestProjection?.point?.lng,
  });

  // Log only when no projection found (critical failure)
  if (!bestProjection?.point) {
    console.warn("[CORRIDOR FAILED]", "NO_VALID_SEGMENT", { busId, minDistance: Math.round(minDistance) });
  }

  // Calculate precise cumulative distance to projected point
  if (bestProjection && bestProjection.point) {
    const segmentStart = normalizedRoute[bestSegmentIndex];
    if (!segmentStart || !bestProjection.point) {
      console.error("[CORRIDOR FAILED]", "INVALID_SEGMENT", { busId, bestSegmentIndex });
      return null;
    }
    const projectedPoint = bestProjection.point;
    const projectedPointToStart = haversineDistance(
      segmentStart.lat, segmentStart.lng,
      projectedPoint.lat, projectedPoint.lng
    );

    // NaN guards before returning projection result
    const safeCumulativeDistance = safeNumber(segmentStartDistance + projectedPointToStart) ?? 0;
    const safeTotalRouteLength = safeNumber(cumulativeDistance) ?? 0;
    const safeMinDistance = safeNumber(minDistance) ?? Infinity;

    const SNAP_THRESHOLD_METERS = 250;
    console.log("[PROJECTION THRESHOLD]", SNAP_THRESHOLD_METERS);

    console.log("[THRESHOLD CHECK]", {
      minDistance: safeMinDistance,
      threshold: SNAP_THRESHOLD_METERS,
      passes: safeMinDistance <= SNAP_THRESHOLD_METERS,
    });

    // Hard snap validation - reject if too far from corridor
    if (safeMinDistance > SNAP_THRESHOLD_METERS) {
      console.log("[SNAP REJECTED]", {
        minDistance: Math.round(safeMinDistance),
        threshold: SNAP_THRESHOLD_METERS,
        busId,
      });
      return null;
    }

    const result = {
      projectedPoint: bestProjection.point,
      snappedLat: projectedPoint.lat,
      snappedLng: projectedPoint.lng,
      cumulativeDistance: safeCumulativeDistance,
      segmentIndex: bestSegmentIndex ?? 0,
      distanceFromCorridor: safeMinDistance ?? null,
      totalRouteLength: safeTotalRouteLength
    };

    console.log("[CORRIDOR SUCCESS]", {
      snappedLat: result.snappedLat,
      snappedLng: result.snappedLng,
      minDistance: safeMinDistance,
      bestSegmentIndex,
    });

    // Projection success - minimal telemetry
    if (result.distanceFromCorridor > 50) {
      console.log("[PROJECTION] Snap warning", {
        busId,
        distance: Math.round(result.distanceFromCorridor),
      });
    }

    return result;
  }

  console.error("[CORRIDOR FAILED]", "NO_PROJECTION", { busId });
  return null;
}

/**
 * Determine current and next stop based on projected position
 * Uses forward-only progression with GPS accuracy-aware arrival thresholds
 * @param {object} projection - Projected bus position
 * @param {string[]} routeStops - Array of stop IDs in route order
 * @param {object} prevProgression - Previous progression state
 * @param {number} accuracy - GPS accuracy in meters
 * @returns {object} - { currentStopIndex, nextStopIndex, passedStopIds }
 */
function determineStopProgression(projection, routeStops, prevProgression, accuracy, busId) {
  // ENTRY TELEMETRY
  console.log("[PROGRESSION ENTRY]", {
    busId,
    hasProjection: !!projection,
    hasProjectedPoint: !!projection?.projectedPoint,
    hasRouteStops: !!routeStops,
    stopCount: routeStops?.length || 0,
    accuracy: accuracy || null
  });
  
  // Validate projection
  if (!projection || !projection.projectedPoint) {
    console.log("[PROGRESSION EXIT]", "NO_PROJECTION");
    return { currentStopIndex: -1, nextStopIndex: -1, passedStopIds: [], currentStopDistance: null };
  }
  
  const { projectedPoint } = projection;
  const prevCurrentIndex = prevProgression?.currentStopIndex ?? -1;
  const prevNextIndex = prevProgression?.nextStopIndex ?? -1;
  
  // GPS ACCURACY-AWARE THRESHOLDS
  // Use dynamic threshold based on GPS quality
  // TEMPORARY: Increased to 80m for diagnostic tolerance
  const effectiveArrivalThreshold = Math.max(
    80, // TEMPORARY: Increased from STOP_ARRIVAL_THRESHOLD_METERS (40)
    accuracy || 0
  );
  const effectiveHysteresis = Math.max(
    STOP_ADVANCE_HYSTERESIS_METERS,
    (accuracy || 0) * 1.5 // 1.5x multiplier for hysteresis
  );
  
  // RAW ROUTE STOPS TELEMETRY
  console.log("[RAW ROUTE STOPS]", routeStops?.slice(0, 3));
  console.log("[STOP RESOLUTION]", {
    stopsCount: routeStops?.length,
    firstStop: routeStops?.[0],
    firstStopType: typeof routeStops?.[0],
  });
  
  // Validate route stops
  if (!routeStops || !Array.isArray(routeStops) || routeStops.length === 0) {
    console.log("[PROGRESSION EXIT]", "NO_STOPS");
    return { currentStopIndex: -1, nextStopIndex: -1, passedStopIds: [], currentStopDistance: null };
  }
  
  // Universal stop normalization - handles both string IDs and object stops
  const normalizedStops = (routeStops || [])
    .map(stop => {
      const safeStopId = getSafeStopId(stop);
      if (!safeStopId) return null;

      if (typeof stop === "string") {
        const coords = getStopCoordsById(safeStopId);
        return coords ? { id: safeStopId, name: getSafeStopName(stop), ...coords } : null;
      }
      
      // Object stop - extract ID and coordinates
      return {
        id: safeStopId,
        name: getSafeStopName(stop),
        lat: stop.lat ?? stop.latitude,
        lng: stop.lng ?? stop.longitude
      };
    })
    .filter(Boolean)
    .filter(stop =>
      typeof stop.lat === "number" &&
      typeof stop.lng === "number"
    );
  
  console.log("[NORMALIZED STOPS]", {
    busId,
    stopCount: normalizedStops.length,
    sample: normalizedStops.slice(0, 3).map(s => ({
      id: s.id,
      lat: s.lat,
      lng: s.lng
    }))
  });
  
  // Normalization validation
  if (!normalizedStops.length) {
    console.log("[PROGRESSION EXIT]", "NO_NORMALIZED_STOPS");
    console.log("[NORMALIZATION FAILURE]", {
      rawStops: routeStops?.slice(0, 3)
    });
    return { currentStopIndex: -1, nextStopIndex: -1, passedStopIds: [], currentStopDistance: null };
  }
  
  // Calculate distance from bus to each stop using projected (snapped) position
  const stopDistances = normalizedStops.map((stop, index) => {
    const distance = haversineDistance(
      projectedPoint.lat, projectedPoint.lng,
      stop.lat, stop.lng
    );
    return { index, stopId: stop.id, distance };
  });

  // Diagnostic telemetry: per-stop distance to projected point with resolved names
  console.log("[STOP DISTANCES]", {
    busId,
    stops: stopDistances.map((s) => ({
      stopIndex: s.index,
      stopName: getSafeStopName({ stopId: s.stopId }),
      stopId: s.stopId,
      distanceToProjection: Math.round(s.distance),
    })),
  });

  // Find nearest stop
  const nearest = stopDistances.reduce((best, current) => 
    current.distance < best.distance ? current : best
  );
  
  // DIAGNOSTIC TELEMETRY: Nearest stop
  console.log("[NEAREST STOP]", {
    busId,
    effectiveLat: projectedPoint.lat,
    effectiveLng: projectedPoint.lng,
    nearestStopId: nearest?.stopId || null,
    nearestDistance: nearest?.distance ? Math.round(nearest.distance) : null,
    threshold: effectiveArrivalThreshold
  });
  
  // DIAGNOSTIC TELEMETRY: Stop matching
  console.log("[STOP MATCH]", {
    nearestStopId: nearest?.stopId || null,
    nearestDistance: nearest?.distance ? Math.round(nearest.distance) : null,
    threshold: effectiveArrivalThreshold,
    stopCount: stopDistances.length,
    stopNames: stopDistances.map(s => ({ id: s.stopId, dist: Math.round(s.distance) }))
  });
  
  let currentStopIndex = -1;
  let nextStopIndex = -1;
  let passedStopIds = prevProgression?.passedStopIds ?? [];
  let currentStopDistance = null; // Track distance for event engine
  
  // FORWARD-ONLY PROGRESSION LOGIC
  // Start from previous position and only move forward
  const startIndex = Math.max(0, prevCurrentIndex);
    // Check if we've arrived at or passed any stop
  for (let i = startIndex; i < stopDistances.length; i++) {
    const stop = stopDistances[i];
    
    // Check if bus is at this stop (within effective arrival threshold based on GPS accuracy)
    if (stop.distance <= effectiveArrivalThreshold) {
      // Arrived at stop i
      if (currentStopIndex !== i) {
        // Moving to new stop - previous current becomes passed
        if (currentStopIndex >= 0 && !passedStopIds.includes(stopDistances[currentStopIndex].stopId)) {
          passedStopIds = [...passedStopIds, stopDistances[currentStopIndex].stopId];
        }
        currentStopIndex = i;
        nextStopIndex = (i + 1 < stopDistances.length) ? i + 1 : -1;
      }
      currentStopDistance = stop.distance; // Record distance for event engine
      break; // Found current stop, stop searching
    }
    
    // Check if we've advanced past a stop (beyond effective hysteresis)
    if (i === startIndex && prevCurrentIndex >= 0 && stop.distance > effectiveHysteresis) {
      // We've moved past the previous current stop
      if (!passedStopIds.includes(stop.stopId)) {
        passedStopIds = [...passedStopIds, stop.stopId];
      }
      // Continue to find next stop
      continue;
    }
    
    // Check if this is the next upcoming stop
    if (stop.distance > effectiveArrivalThreshold && currentStopIndex < 0) {
      // Haven't arrived at any stop yet, this is the next one
      nextStopIndex = i;
      break;
    }
  }
  
  // Handle edge cases
  if (currentStopIndex < 0 && nextStopIndex < 0) {
    // Before first stop
    nextStopIndex = 0;
  }
  
  // Calculate next stop distance for ETA
  let nextStopDistance = null;
  if (nextStopIndex >= 0 && stopDistances[nextStopIndex]) {
    nextStopDistance = stopDistances[nextStopIndex].distance;
  }
  
  return { currentStopIndex, nextStopIndex, passedStopIds, currentStopDistance, nextStopDistance, effectiveArrivalThreshold, effectiveHysteresis };
}

/**
 * Calculate ETA based on remaining distance and rolling average speed
 */
function calculateETA(remainingDistanceKm, busId) {
  // Get rolling average speed
  let avgSpeed = getRollingAverageSpeed(busId);
  
  // Fallback to minimum operational speed if too low
  if (avgSpeed < MIN_SPEED_KMH) {
    avgSpeed = MIN_SPEED_KMH;
  }
  
  // Calculate ETA in minutes
  const etaMinutes = (remainingDistanceKm / avgSpeed) * 60;
  
  return {
    etaMinutes: Math.round(etaMinutes),
    avgSpeedKmh: Math.round(avgSpeed * 10) / 10
  };
}


/**
 * Densify sparse route coordinates to ~15m spacing for accurate snapping
 */
function densifyRouteCoords(coords) {
  if (!coords || coords.length < 2) return coords || [];
  const dense = [coords[0]];
  for (let i = 0; i < coords.length - 1; i++) {
    const start = coords[i];
    const end = coords[i + 1];
    const segDist = distanceMeters(start.lat, start.lng, end.lat, end.lng);
    const steps = Math.max(3, Math.ceil(segDist / 15));
    for (let j = 1; j < steps; j++) {
      const t = j / steps;
      dense.push({
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
      });
    }
    dense.push(end);
  }
  return dense;
}

function computeBusProgression(busId, busLat, busLng, speedMps, route, accuracy) {
  try {
    console.log("[ENGINE ENTRY]", {
      busId,
      hasStops: !!route?.stops?.length,
      stopsCount: route?.stops?.length,
      hasRouteCoords: !!(route?.routeCoords?.length || route?.coordinates?.length),
      routeCoordsCount: route?.routeCoords?.length || route?.coordinates?.length,
    });

    if (!Number.isFinite(busLat) || !Number.isFinite(busLng) || !route) {
      console.log("[PROGRESSION EARLY RETURN]", "INVALID_INPUTS");
      return createFallbackProgression(busId, null, null);
    }

    const gpsConfidence = getGpsConfidence(accuracy);

    // ROUTE HYDRATION: Normalize route coordinates ONCE
    const rawRouteCoords = route?.routeCoords || route?.coordinates || [];
    let normalizedRouteCoords = (Array.isArray(rawRouteCoords) ? rawRouteCoords : [])
      .map(toLatLng)
      .filter(Boolean);

    if (normalizedRouteCoords.length < 2) {
      console.log("[PROGRESSION EARLY RETURN]", "NO_ROUTE_COORDS");
      return createFallbackProgression(busId, gpsConfidence, accuracy);
    }

    // DENSIFY: interpolate to ~15m spacing for accurate snapping
    normalizedRouteCoords = densifyRouteCoords(normalizedRouteCoords);
    console.log("[DENSIFIED ROUTE]", { originalCount: rawRouteCoords.length, denseCount: normalizedRouteCoords.length });

    // Build normalized stops
    const rawStops = route?.stops || [];
    const demoStops = rawStops.map((stop) => {
      if (typeof stop === "string") {
        const coords = getStopCoordsById(stop);
        return coords ? { stopId: stop, name: getSafeStopName(stop), lat: coords.lat, lng: coords.lng } : null;
      }
      const lat = stop.lat ?? stop.latitude;
      const lng = stop.lng ?? stop.longitude;
      const stopId = stop.stopId || stop.id || stop._id || null;
      const name = stop.name || getSafeStopName(stop) || null;
      return typeof lat === "number" && typeof lng === "number" ? { stopId, name, lat, lng } : null;
    }).filter(Boolean);

    if (demoStops.length < 2) {
      console.log("[PROGRESSION EARLY RETURN]", "INSUFFICIENT_STOPS", { stopCount: demoStops.length });
      return createFallbackProgression(busId, gpsConfidence, accuracy);
    }

    // 1. Find nearest route coordinate index to bus
    let nearestCoordIndex = 0;
    let minCoordDist = Infinity;
    normalizedRouteCoords.forEach((coord, idx) => {
      const d = distanceMeters(busLat, busLng, coord.lat, coord.lng);
      if (d < minCoordDist) {
        minCoordDist = d;
        nearestCoordIndex = idx;
      }
    });

    const snappedLat = normalizedRouteCoords[nearestCoordIndex].lat;
    const snappedLng = normalizedRouteCoords[nearestCoordIndex].lng;
    const distanceFromRoute = minCoordDist;

    // 2. Map each stop to its nearest route coordinate index
    const stopCoordIndices = demoStops.map((stop) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      normalizedRouteCoords.forEach((coord, idx) => {
        const d = distanceMeters(stop.lat, stop.lng, coord.lat, coord.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });
      return bestIdx;
    });

    // 3. Determine raw current/next stops from bus position on route
    let rawCurrentStopIndex = -1;
    let rawNextStopIndex = -1;
    for (let i = 0; i < demoStops.length; i++) {
      if (stopCoordIndices[i] <= nearestCoordIndex) {
        rawCurrentStopIndex = i;
      }
      if (stopCoordIndices[i] > nearestCoordIndex && rawNextStopIndex === -1) {
        rawNextStopIndex = i;
      }
    }
    if (rawCurrentStopIndex < 0) rawCurrentStopIndex = 0;
    if (rawNextStopIndex < 0) rawNextStopIndex = Math.min(rawCurrentStopIndex + 1, demoStops.length - 1);

    // 4. Forward-only jitter protection
    const prevProgression = getBusProgression(busId);
    const previousCurrentIndex = Number.isFinite(prevProgression?.currentStopIndex)
      ? prevProgression.currentStopIndex
      : -1;

    let currentStopIndex = rawCurrentStopIndex;
    let nextStopIndex = rawNextStopIndex;

    if (previousCurrentIndex >= 0 && rawCurrentStopIndex < previousCurrentIndex) {
      currentStopIndex = previousCurrentIndex;
      nextStopIndex = Math.min(previousCurrentIndex + 1, demoStops.length - 1);
    }

    // Safety clamps
    if (currentStopIndex < 0) currentStopIndex = 0;
    if (currentStopIndex >= demoStops.length) currentStopIndex = demoStops.length - 1;
    if (nextStopIndex <= currentStopIndex) nextStopIndex = Math.min(currentStopIndex + 1, demoStops.length - 1);
    if (nextStopIndex >= demoStops.length) nextStopIndex = demoStops.length - 1;

    const currentStop = demoStops[currentStopIndex];
    const nextStop = demoStops[nextStopIndex];

    // 5. SPEED: GPS speed if available (> 5 km/h), otherwise derivedSpeed, with moving average
    const gpsSpeedKmh = (speedMps && speedMps > 0) ? speedMps * 3.6 : 0;
    const prevTrackingState = getTrackingState(busId);
    const derivedSpeed = prevTrackingState?.derivedSpeed ?? 0;

    let finalSpeedKmh = gpsSpeedKmh > 5 ? gpsSpeedKmh : (derivedSpeed > 5 ? derivedSpeed : 15);
    finalSpeedKmh = Math.min(finalSpeedKmh, 120); // Clamp to max reasonable speed

    // Add to rolling average and get smoothed speed
    addSpeedSample(busId, finalSpeedKmh);
    const rollingSpeedKmh = getRollingAverageSpeed(busId);

    // 6. ETA: distance along route from bus to next stop
    let nextDistanceAlongRoute = 0;
    for (let i = nearestCoordIndex; i < stopCoordIndices[nextStopIndex] && i < normalizedRouteCoords.length - 1; i++) {
      nextDistanceAlongRoute += distanceMeters(
        normalizedRouteCoords[i].lat, normalizedRouteCoords[i].lng,
        normalizedRouteCoords[i + 1].lat, normalizedRouteCoords[i + 1].lng
      );
    }
    // Add straight-line from bus to nearest coord
    nextDistanceAlongRoute += distanceMeters(busLat, busLng, snappedLat, snappedLng);

    const etaSpeedKmh = Math.max(15, rollingSpeedKmh);
    const etaMinutes = nextDistanceAlongRoute > 50
      ? Math.max(1, Math.round(nextDistanceAlongRoute / ((etaSpeedKmh * 1000) / 60)))
      : 0;

    // 7. Progress percent
    const routeProgressPercent = Math.round(
      (nearestCoordIndex / Math.max(1, normalizedRouteCoords.length - 1)) * 100
    );

    // passedStopIds
    const passedStopIds = [];
    for (let i = 0; i < currentStopIndex; i++) {
      if (demoStops[i]?.stopId) passedStopIds.push(demoStops[i].stopId);
    }

    console.log("[ROUTE-POLYLINE PROGRESSION]", {
      nearestCoordIndex,
      currentStopIndex,
      nextStopIndex,
      currentStop: currentStop?.name,
      nextStop: nextStop?.name,
      etaMinutes,
      routeProgressPercent,
      rollingSpeedKmh: Math.round(rollingSpeedKmh * 10) / 10,
    });

    const progression = {
      busId,
      isSnapped: true,
      nearestRouteIndex: nearestCoordIndex,
      snappedLat,
      snappedLng,
      distanceFromRoute: Math.round(distanceFromRoute),
      gpsConfidence,
      gpsAccuracy: safeNumber(accuracy) ?? null,
      tripId: route.tripId || null,
      routeId: route.routeId || null,
      currentStopIndex,
      routeProgressIndex: currentStopIndex,
      currentStopId: currentStop?.stopId ?? null,
      currentStopName: currentStop?.name ?? null,
      nextStopIndex,
      nextStopId: nextStop?.stopId ?? null,
      nextStopName: nextStop?.name ?? null,
      passedStopIds,
      remainingDistanceKm: 0,
      remainingDistanceMeters: Math.round(nextDistanceAlongRoute),
      progressPercent: routeProgressPercent,
      etaMinutes,
      avgSpeedKmh: Math.round(rollingSpeedKmh * 10) / 10,
      derivedSpeed: finalSpeedKmh,
      occupancy: Math.floor(25 + Math.random() * 35),
      capacity: 50,
      cumulativeDistance: 0,
      totalRouteLength: 0,
      lastProjectedPoint: { lat: snappedLat, lng: snappedLng },
      lastUpdate: Date.now(),
      jitterFiltered: false,
    };

    // Store updated progression
    setBusProgression(busId, progression);

    return progression;
  } catch (error) {
    console.error("[PROGRESSION] CRASH", {
      busId,
      error: error.message,
      stack: error.stack?.split('\n')[0]
    });
    return createFallbackProgression(busId, gpsConfidence, accuracy);
  }
}
/**
 * Check if progression changed meaningfully (for emission throttling)
 */
function hasProgressionChanged(newProgression, oldProgression) {
  if (!oldProgression) return true;
  
  // Check stop index changes
  if (newProgression.currentStopIndex !== oldProgression.currentStopIndex) return true;
  if (newProgression.nextStopIndex !== oldProgression.nextStopIndex) return true;
  
  // Check passed stops changes
  if (JSON.stringify(newProgression.passedStopIds) !== JSON.stringify(oldProgression.passedStopIds)) return true;
  
  // Check ETA changes (> 1 minute difference)
  const etaDiff = Math.abs(newProgression.etaMinutes - oldProgression.etaMinutes);
  if (etaDiff >= 1) return true;
  
  // Check progress percentage changes (> 2% difference)
  const progressDiff = Math.abs(newProgression.progressPercent - oldProgression.progressPercent);
  if (progressDiff >= 2) return true;
  
  return false;
}

/**
 * Clear all progression and event state for a bus
 * Call this on STOP_TRACKING, BUS_OFFLINE, trip change, or direction change
 * @param {string} busId - Bus identifier
 */
function clearBusState(busId) {
  // Clear progression cache
  progressionState.delete(busId);
  
  // Clear stop event state
  stopEventState.delete(busId);
  
  // Clear ETA state
  etaState.delete(busId);
  
  console.log(`[State Cleanup] Cleared all state for bus ${busId}`);
}

/**
 * Clear progression state only (for trip/direction changes)
 * @param {string} busId - Bus identifier
 */
function clearBusProgression(busId) {
  progressionState.delete(busId);
  
  // Also clear event tracking to allow fresh events for new trip
  const eventState = stopEventState.get(busId);
  if (eventState) {
    eventState.lastEventStopId = null;
    eventState.lastEventType = null;
    eventState.hasApproached = new Map();
  }

  // Reset ETA state for new trip
  const eta = etaState.get(busId);
  if (eta) {
    eta.nextStopId = null;
    eta.hasApproached = new Map();
  }

  console.log(`[State Cleanup] Cleared progression for bus ${busId}`);
}

module.exports = {
  computeBusProgression,
  hasProgressionChanged,
  projectOntoRouteCorridor,
  snapToRouteCorridor, // Route corridor locking for visual positioning
  onStopEvent, // Stop lifecycle event registration
  clearBusState, // Full cleanup for offline/disconnect
  clearBusProgression, // Partial cleanup for trip change
  haversineDistance,
  densifyRouteCoords, // Dense coordinate interpolation
  GPS_JITTER_THRESHOLD_METERS // Export for unified use
};
