/**
 * Bus Stop Progression Engine
 * 
 * Backend-driven progression calculation with GPS jitter protection.
 * Projects bus position onto route corridor and computes stop progression.
 */

const routes = require("../../data/routes");
const { getBusProgression, setBusProgression, addSpeedSample, getRollingAverageSpeed } = require("./trackingState");
const { getStopNameById, ALL_STOPS } = require("../services/overpassService");

// Hysteresis thresholds
const MIN_ADVANCEMENT_METERS = 50; // Must advance 50m before updating stop index
const GPS_JITTER_THRESHOLD_METERS = 15; // Unified threshold: ignore movements less than 15m
const MIN_SPEED_KMH = 5; // Minimum operational speed for ETA calculation

// STOP ARRIVAL DETECTION thresholds
const STOP_ARRIVAL_THRESHOLD_METERS = 40; // Bus must be within 40m to be "at" stop
const STOP_ADVANCE_HYSTERESIS_METERS = 60; // Must advance 60m past stop to move to next
const MAX_USABLE_ACCURACY_METERS = 80; // Maximum GPS accuracy we can use for progression

// ROUTE SNAPPING thresholds
const ROUTE_SNAP_THRESHOLD_METERS = 100; // Maximum distance from route to snap (otherwise use raw GPS)
const ROUTE_SNAP_MAX_DISTANCE_METERS = 150; // Hard cutoff - beyond this, no snapping at all

// STOP EVENT ENGINE
// Per-bus stop event state for lifecycle tracking (APPROACHING -> ARRIVED -> DWELLING -> DEPARTED)
const stopEventState = new Map();

// ETA STATE
// Per-bus ETA state for stable predictions
const etaState = new Map();

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
  
  // Rolling average: 70% old + 30% new
  state.rollingSpeedKmh = (state.rollingSpeedKmh * 0.7) + (effectiveSpeed * 0.3);
  
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
        stopName: getStopNameById(state.currentStopId),
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
      stopName: getStopNameById(state.currentStopId),
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
        stopName: getStopNameById(currentStopId),
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
          stopName: getStopNameById(currentStopId),
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
        stopName: getStopNameById(currentStopId),
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
        stopName: getStopNameById(currentStopId),
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

// Build stop coordinate lookup map
const STOP_COORDS_MAP = new Map(
  ALL_STOPS.map(stop => [String(stop.id), { lat: stop.lat, lng: stop.lng }])
);

/**
 * Get stop coordinates by ID
 * @param {string} stopId - Stop identifier
 * @returns {{lat: number, lng: number} | null}
 */
function getStopCoordsById(stopId) {
  if (!stopId) return null;
  return STOP_COORDS_MAP.get(String(stopId)) || null;
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
    const segmentStart = routeCoords[i];
    const segmentEnd = routeCoords[i + 1];
    
    // Validate segment structure
    if (!Array.isArray(segmentStart) || !Array.isArray(segmentEnd)) {
      continue;
    }
    if (segmentStart.length < 2 || segmentEnd.length < 2) {
      continue;
    }
    if (!Number.isFinite(segmentStart[0]) || !Number.isFinite(segmentStart[1]) ||
        !Number.isFinite(segmentEnd[0]) || !Number.isFinite(segmentEnd[1])) {
      continue;
    }
    
    // Defensive: catch any math errors in projection
    let projection = null;
    try {
      projection = projectPointOntoSegment(
        [lat, lng],
        segmentStart,
        segmentEnd
      );
    } catch (err) {
      // Skip this segment if projection fails
      continue;
    }
    
    if (projection && projection.distance < minDistance && 
        Number.isFinite(projection.distance) &&
        Array.isArray(projection.point) &&
        Number.isFinite(projection.point[0]) &&
        Number.isFinite(projection.point[1])) {
      minDistance = projection.distance;
      snappedPoint = projection.point;
      snappedSegmentIndex = i;
      bestSegmentStart = segmentStart;
      bestSegmentEnd = segmentEnd;
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
  if (!snappedPoint || !Array.isArray(snappedPoint) || snappedPoint.length < 2) {
    console.log("[SNAP RESULT] No valid snapped point found");
    return null;
  }
  const snappedLat = snappedPoint[0];
  const snappedLng = snappedPoint[1];
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
      snappedLat: snappedPoint[0],
      snappedLng: snappedPoint[1],
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
      snappedLat: snappedPoint[0],
      snappedLng: snappedPoint[1],
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
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Find nearest point on a line segment
 * Returns: { point: [lat, lng], distance: meters, segmentIndex: number }
 */
function projectPointOntoSegment(point, segmentStart, segmentEnd) {
  const [px, py] = point;
  const [x1, y1] = segmentStart;
  const [x2, y2] = segmentEnd;
  
  // Convert to local meters approximation
  const latAvg = (x1 + x2) / 2;
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
  const projLat = x1 + t * (x2 - x1);
  const projLng = y1 + t * (y2 - y1);
  
  // Calculate distance from point to projection
  const distance = haversineDistance(px, py, projLat, projLng);
  
  return {
    point: [projLat, projLng],
    distance,
    t // Parameter along segment (0-1)
  };
}

/**
 * Project GPS position onto route corridor
 * Returns: { projectedPoint, cumulativeDistance, segmentIndex, distanceFromCorridor }
 */
function projectOntoRouteCorridor(busLat, busLng, routeCoordinates, busId = "unknown") {
  // ENTRY TELEMETRY
  console.log("[PROJECTION ENTRY]", {
    busId,
    lat: busLat,
    lng: busLng,
    hasRouteCoords: !!routeCoordinates,
    coordCount: routeCoordinates?.length || 0,
    sample: routeCoordinates?.slice(0, 2)
  });
  
  // Validate route coordinates exist
  if (!routeCoordinates || !Array.isArray(routeCoordinates)) {
    console.log("[PROJECTION EXIT]", "EMPTY_ROUTE", { busId });
    return null;
  }
  
  if (routeCoordinates.length < 2) {
    console.log("[PROJECTION EXIT]", "INSUFFICIENT_ROUTE_COORDS", { 
      busId, 
      length: routeCoordinates.length 
    });
    return null;
  }
  
  // Validate route coordinate structure
  const invalidCoords = routeCoordinates.filter(
    point =>
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number"
  );
  
  if (invalidCoords.length > 0) {
    console.log("[PROJECTION EXIT]", "INVALID_ROUTE_COORDS", {
      busId,
      invalidCount: invalidCoords.length,
      invalidSample: invalidCoords.slice(0, 3),
      validSample: routeCoordinates.filter(p => 
        Array.isArray(p) && p.length === 2 && typeof p[0] === "number"
      ).slice(0, 3)
    });
    return null;
  }
  
  // Coordinate order telemetry
  console.log("[COORD ORDER CHECK]", {
    busId,
    firstPoint: routeCoordinates[0],
    lastPoint: routeCoordinates[routeCoordinates.length - 1],
    expectedFormat: "[lat, lng]"
  });
  
  let minDistance = Infinity;
  let bestProjection = null;
  let cumulativeDistance = 0;
  let bestSegmentIndex = 0;
  let segmentStartDistance = 0;
  
  // Check each segment of the route
  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    const segmentStart = routeCoordinates[i];
    const segmentEnd = routeCoordinates[i + 1];
    
    const projection = projectPointOntoSegment(
      [busLat, busLng],
      segmentStart,
      segmentEnd
    );
    
    if (projection.distance < minDistance) {
      minDistance = projection.distance;
      bestProjection = projection;
      bestSegmentIndex = i;
      segmentStartDistance = cumulativeDistance;
    }
    
    // Add segment length to cumulative
    const segmentLength = haversineDistance(
      segmentStart[0], segmentStart[1],
      segmentEnd[0], segmentEnd[1]
    );
    cumulativeDistance += segmentLength;
  }
  
  // Calculate precise cumulative distance to projected point
  if (bestProjection) {
    const segmentStart = routeCoordinates[bestSegmentIndex];
    const projectedPointToStart = haversineDistance(
      segmentStart[0], segmentStart[1],
      bestProjection.point[0], bestProjection.point[1]
    );
    
    const result = {
      projectedPoint: bestProjection.point,
      cumulativeDistance: segmentStartDistance + projectedPointToStart,
      segmentIndex: bestSegmentIndex,
      distanceFromCorridor: minDistance,
      totalRouteLength: cumulativeDistance
    };
    
    // PROJECTION RESULT TELEMETRY
    console.log("[PROJECTION RESULT]", {
      busId,
      projectedPoint: result.projectedPoint,
      distanceFromRoute: result.distanceFromCorridor,
      routeProgressIndex: result.segmentIndex,
      isValidProjection:
        !!result.projectedPoint &&
        Array.isArray(result.projectedPoint) &&
        result.projectedPoint.length === 2
    });
    
    return result;
  }
  
  // No valid projection found
  console.log("[PROJECTION EXIT]", "NO_CLOSEST_SEGMENT", {
    busId,
    minDistance,
    coordCount: routeCoordinates.length
  });
  
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
  
  // Validate route stops
  if (!routeStops || !Array.isArray(routeStops) || routeStops.length === 0) {
    console.log("[PROGRESSION EXIT]", "NO_STOPS");
    return { currentStopIndex: -1, nextStopIndex: -1, passedStopIds: [], currentStopDistance: null };
  }
  
  // Universal stop normalization - handles both string IDs and object stops
  const normalizedStops = (routeStops || [])
    .map(stop => {
      if (typeof stop === "string") {
        const coords = getStopCoordsById(stop);
        return coords ? { id: stop, ...coords } : null;
      }
      
      // Object stop - extract ID and coordinates
      return {
        id: stop.id,
        name: stop.name,
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
      projectedPoint[0], projectedPoint[1],
      stop.lat, stop.lng
    );
    return { index, stopId: stop.id, distance };
  });
  
  // Find nearest stop
  const nearest = stopDistances.reduce((best, current) => 
    current.distance < best.distance ? current : best
  );
  
  // DIAGNOSTIC TELEMETRY: Nearest stop
  console.log("[NEAREST STOP]", {
    busId,
    effectiveLat: projectedPoint[0],
    effectiveLng: projectedPoint[1],
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
  let passedStopIds = prevProgression?.passedStopIds || [];
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
  
  return { currentStopIndex, nextStopIndex, passedStopIds, currentStopDistance, nextStopDistance };
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
 * Main progression computation function
 * Called during each BUS_LOCATION_UPDATE
 */
function computeBusProgression(busId, busLat, busLng, speedMps, route, accuracy) {
  // ENTRY TELEMETRY
  console.log("[COMPUTE ENTRY]", {
    busId,
    lat: busLat,
    lng: busLng,
    hasRoute: !!route,
    routeId: route?.routeId || route?.id || null,
    hasRouteCoords: !!route?.routeCoords,
    coordCount: route?.routeCoords?.length || 0,
    hasCoordinates: !!route?.coordinates,
    coordCount2: route?.coordinates?.length || 0,
    hasStops: !!route?.stops,
    stopCount: route?.stops?.length || 0
  });
  
  // Validate inputs
  if (!Number.isFinite(busLat) || !Number.isFinite(busLng) || !route) {
    console.log("[COMPUTE EXIT]", "NO_ROUTE", { busId });
    return null;
  }
  
  // ROUTE HYDRATION: Normalize route coordinates ONCE
  const normalizedRouteCoords =
    route?.routeCoords ||
    route?.coordinates ||
    [];
  
  // Hard validation for route coordinates
  if (
    !Array.isArray(normalizedRouteCoords) ||
    normalizedRouteCoords.length < 2
  ) {
    console.log("[COMPUTE EXIT]", "NO_ROUTE_COORDS", {
      busId,
      routeId: route?.id || route?.routeId || null,
      hasRouteCoords: !!route?.routeCoords,
      hasCoordinates: !!route?.coordinates,
      coordsLength: normalizedRouteCoords?.length || 0
    });
    return null;
  }
  
  // Create normalized route object with guaranteed coordinates
  const normalizedRoute = {
    ...route,
    routeCoords: normalizedRouteCoords,
    coordinates: normalizedRouteCoords // Ensure both properties exist
  };
  
  console.log("[COMPUTE]", "ROUTE_NORMALIZED", {
    busId,
    normalizedCoordCount: normalizedRoute.routeCoords.length
  });
  
  // Get previous progression state
  const prevProgression = getBusProgression(busId);
  
  // GPS ACCURACY CHECK: Reject unusable GPS
  const gpsConfidence = getGpsConfidence(accuracy);
  if (gpsConfidence === "UNUSABLE") {
    console.log("[COMPUTE EXIT]", "GPS_UNUSABLE", {
      busId,
      accuracy,
      threshold: MAX_USABLE_ACCURACY_METERS
    });
    return {
      ...prevProgression,
      lastUpdate: Date.now(),
      gpsConfidence,
      gpsAccuracy: accuracy
    };
  }
  
  // Convert speed to km/h for display
  const speedKmh = speedMps * 3.6;
  
  // Telemetry before projection invocation
  console.log("[COMPUTE]", "CALLING_PROJECTION", {
    busId,
    coordCount: normalizedRoute.routeCoords.length
  });
  
  // Project bus position onto route corridor (using normalized coordinates)
  const projection = projectOntoRouteCorridor(busLat, busLng, normalizedRoute.routeCoords, busId);
  
  // Telemetry after projection returns
  console.log("[COMPUTE]", "PROJECTION_RESPONSE", {
    busId,
    hasProjection: !!projection,
    projectedPoint: projection?.projectedPoint || null,
    distanceFromRoute: projection?.distanceFromCorridor || null,
    segmentIndex: projection?.segmentIndex || null
  });
  
  if (!projection) {
    console.log("[COMPUTE EXIT]", "PROJECTION_FAILED", { busId });
    return null;
  }
  
  // GPS Jitter Check: Ignore tiny movements
  let jitterFiltered = false;
  if (prevProgression?.lastProjectedPoint) {
    const moveDistance = haversineDistance(
      prevProgression.lastProjectedPoint[0],
      prevProgression.lastProjectedPoint[1],
      projection.projectedPoint[0],
      projection.projectedPoint[1]
    );
    
    if (moveDistance < GPS_JITTER_THRESHOLD_METERS) {
      // Too small to process - return previous progression with updated time
      jitterFiltered = true;
      console.log("[PROGRESSION JITTER]", {
        busId,
        moveDistance: Math.round(moveDistance) + "m",
        threshold: GPS_JITTER_THRESHOLD_METERS + "m",
        action: "filtered"
      });
      return {
        ...prevProgression,
        lastUpdate: Date.now(),
        jitterFiltered: true
      };
    }
  }
  
  // Telemetry before stop progression
  console.log("[COMPUTE]", "CALLING_STOP_PROGRESSION", {
    busId,
    stopCount: normalizedRoute.stops?.length || 0
  });
  
  // Determine stop progression with GPS accuracy awareness
  const stopProgress = determineStopProgression(
    projection,
    normalizedRoute.stops,
    prevProgression,
    accuracy,
    busId
  );
  
  // Telemetry after stop progression
  console.log("[COMPUTE]", "STOP_PROGRESSION_RESPONSE", {
    busId,
    currentStopIndex: stopProgress?.currentStopIndex,
    nextStopIndex: stopProgress?.nextStopIndex,
    passedCount: stopProgress?.passedStopIds?.length || 0
  });
  
  // Get stop names for display
  const currentStopId = stopProgress.currentStopIndex >= 0 ? normalizedRoute.stops[stopProgress.currentStopIndex] : null;
  const nextStopId = stopProgress.nextStopIndex >= 0 ? normalizedRoute.stops[stopProgress.nextStopIndex] : null;
  const currentStopName = currentStopId ? getStopNameById(currentStopId) : null;
  const nextStopName = nextStopId ? getStopNameById(nextStopId) : null;

  // Calculate remaining distance along corridor
  const remainingDistanceKm = (projection.totalRouteLength - projection.cumulativeDistance) / 1000;
  
  // Calculate progress percentage
  const progressPercent = Math.round(
    (projection.cumulativeDistance / projection.totalRouteLength) * 100
  );
  
  // Calculate ETA using stable rolling speed smoothing
  // Get distance to next stop from stopProgress (now includes nextStopDistance)
  let nextStopDistanceMeters = stopProgress.nextStopDistance || 0;
  if (!nextStopDistanceMeters && stopProgress.currentStopDistance !== null) {
    // No next stop, use current stop distance
    nextStopDistanceMeters = stopProgress.currentStopDistance;
  }
  
  const { etaMinutes, remainingDistanceMeters, rollingSpeedKmh } = computeEta(
    busId,
    nextStopId,
    nextStopDistanceMeters,
    speedKmh
  );
  
  // Check for APPROACHING event (within 2 minutes of stop)
  checkApproachingEvent(busId, nextStopId, etaMinutes, nextStopName);

  // Calculate effective arrival threshold based on GPS accuracy
  const effectiveThreshold = Math.max(
    STOP_ARRIVAL_THRESHOLD_METERS,
    accuracy || 0
  );

  // Build progression result
  const progression = {
    busId,
    gpsConfidence,
    gpsAccuracy: accuracy || null,
    effectiveThreshold,
    tripId: state.tripId,
    routeId: state.routeId,
    currentStopIndex: stopProgress.currentStopIndex,
    currentStopId,
    currentStopName,
    nextStopIndex: stopProgress.nextStopIndex,
    nextStopId,
    nextStopName,
    passedStopIds: stopProgress.passedStopIds,
    remainingDistanceKm: Math.round(remainingDistanceKm * 100) / 100,
    remainingDistanceMeters, // Distance to next stop
    progressPercent,
    etaMinutes,
    avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
    cumulativeDistance: Math.round(projection.cumulativeDistance),
    totalRouteLength: Math.round(projection.totalRouteLength),
    lastProjectedPoint: projection.projectedPoint,
    lastUpdate: Date.now(),
    jitterFiltered,
    routeCoords: normalizedRoute.routeCoords // Store normalized coords for downstream use
  };
  
  // DIAGNOSTIC TELEMETRY: Progression result
  console.log("[PROGRESSION RESULT]", {
    busId,
    currentStopId: progression.currentStopId,
    currentStopName: progression.currentStopName,
    nextStopId: progression.nextStopId,
    nextStopName: progression.nextStopName,
    passedStops: progression.passedStopIds?.length || 0,
    eta: progression.etaMinutes || null,
    progress: progression.progressPercent + "%"
  });
  
  // STOP EVENT ENGINE: Detect ARRIVAL, DWELLING, DEPARTURE lifecycle events
  updateStopEventState(
    busId,
    progression,
    stopProgress.currentStopDistance,
    effectiveArrivalThreshold,
    effectiveHysteresis
  );
  
  // Store updated progression
  setBusProgression(busId, progression);
  
  // Debug instrumentation
  console.log("[PROGRESSION]", {
    busId,
    currentStopIndex: progression.currentStopIndex,
    nextStopIndex: progression.nextStopIndex,
    remainingDistanceKm: progression.remainingDistanceKm,
    progressPercent: progression.progressPercent + "%",
    etaMinutes: progression.etaMinutes + "min",
    avgSpeed: avgSpeedKmh + "km/h",
    cumulativeDistance: Math.round(projection.cumulativeDistance) + "m",
    totalRouteLength: Math.round(projection.totalRouteLength) + "m",
    jitterFiltered
  });
  
  return progression;
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
  GPS_JITTER_THRESHOLD_METERS // Export for unified use
};
