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
  if (!routeCoords || routeCoords.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  
  let minDistance = Infinity;
  let snappedPoint = null;
  let snappedSegmentIndex = -1;
  
  // Find nearest segment
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const segmentStart = routeCoords[i];
    const segmentEnd = routeCoords[i + 1];
    
    const projection = projectPointOntoSegment(
      [lat, lng],
      segmentStart,
      segmentEnd
    );
    
    if (projection && projection.distance < minDistance) {
      minDistance = projection.distance;
      snappedPoint = projection.point;
      snappedSegmentIndex = i;
    }
  }
  
  // Hard cutoff: beyond 150m, no snapping at all
  if (minDistance > ROUTE_SNAP_MAX_DISTANCE_METERS) {
    return null;
  }
  
  // Soft threshold: within 100m, return snapped coordinates
  // Between 100-150m, still snap but with warning flag (for debugging)
  if (minDistance <= ROUTE_SNAP_THRESHOLD_METERS) {
    return {
      snappedLat: snappedPoint[0],
      snappedLng: snappedPoint[1],
      distanceFromRoute: minDistance,
      isSnapped: true,
      segmentIndex: snappedSegmentIndex
    };
  }
  
  // Between 100-150m: soft snap with warning
  if (minDistance <= ROUTE_SNAP_MAX_DISTANCE_METERS) {
    return {
      snappedLat: snappedPoint[0],
      snappedLng: snappedPoint[1],
      distanceFromRoute: minDistance,
      isSnapped: true,
      isSoftSnap: true, // Flag for potential off-route warning
      segmentIndex: snappedSegmentIndex
    };
  }
  
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
function projectOntoRouteCorridor(busLat, busLng, routeCoordinates) {
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
    
    return {
      projectedPoint: bestProjection.point,
      cumulativeDistance: segmentStartDistance + projectedPointToStart,
      segmentIndex: bestSegmentIndex,
      distanceFromCorridor: minDistance,
      totalRouteLength: cumulativeDistance
    };
  }
  
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
function determineStopProgression(projection, routeStops, prevProgression, accuracy) {
  const { projectedPoint } = projection;
  const prevCurrentIndex = prevProgression?.currentStopIndex ?? -1;
  const prevNextIndex = prevProgression?.nextStopIndex ?? -1;
  
  // GPS ACCURACY-AWARE THRESHOLDS
  // Use dynamic threshold based on GPS quality
  const effectiveArrivalThreshold = Math.max(
    STOP_ARRIVAL_THRESHOLD_METERS,
    accuracy || 0
  );
  const effectiveHysteresis = Math.max(
    STOP_ADVANCE_HYSTERESIS_METERS,
    (accuracy || 0) * 1.5 // 1.5x multiplier for hysteresis
  );
  
  // Get stop coordinates array for this route
  const stopCoords = routeStops.map(id => getStopCoordsById(id)).filter(Boolean);
  if (stopCoords.length === 0) {
    return { currentStopIndex: -1, nextStopIndex: -1, passedStopIds: [] };
  }
  
  // Calculate distance from bus to each stop
  const stopDistances = stopCoords.map((coord, index) => {
    const distance = haversineDistance(
      projectedPoint[0], projectedPoint[1],
      coord.lat, coord.lng
    );
    return { index, stopId: routeStops[index], distance };
  });
  
  // Find nearest stop
  const nearest = stopDistances.reduce((best, current) => 
    current.distance < best.distance ? current : best
  );
  
  let currentStopIndex = -1;
  let nextStopIndex = -1;
  let passedStopIds = prevProgression?.passedStopIds || [];
  
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
        if (currentStopIndex >= 0 && !passedStopIds.includes(routeStops[currentStopIndex])) {
          passedStopIds = [...passedStopIds, routeStops[currentStopIndex]];
        }
        currentStopIndex = i;
        nextStopIndex = (i + 1 < stopDistances.length) ? i + 1 : -1;
      }
      break; // Found current stop, stop searching
    }
    
    // Check if we've advanced past a stop (beyond effective hysteresis)
    if (i === startIndex && prevCurrentIndex >= 0 && stop.distance > effectiveHysteresis) {
      // We've moved past the previous current stop
      if (!passedStopIds.includes(routeStops[i])) {
        passedStopIds = [...passedStopIds, routeStops[i]];
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
  
  return { currentStopIndex, nextStopIndex, passedStopIds };
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
  // Validate inputs
  if (!Number.isFinite(busLat) || !Number.isFinite(busLng) || !route) {
    console.log(`[Progression] Invalid inputs for bus ${busId}`);
    return null;
  }
  
  // Get previous progression state
  const prevProgression = getBusProgression(busId);
  
  // GPS ACCURACY CHECK: Reject unusable GPS
  const gpsConfidence = getGpsConfidence(accuracy);
  if (gpsConfidence === "UNUSABLE") {
    console.log(`[Progression GPS] Bus ${busId} accuracy ${accuracy}m exceeds ${MAX_USABLE_ACCURACY_METERS}m, returning previous state`);
    return {
      ...prevProgression,
      lastUpdate: Date.now(),
      gpsConfidence,
      gpsAccuracy: accuracy
    };
  }
  
  // Convert speed to km/h for display
  const speedKmh = speedMps * 3.6;
  
  // Project bus position onto route corridor
  const projection = projectOntoRouteCorridor(busLat, busLng, route.coordinates);
  
  if (!projection) {
    console.log(`[Progression] Failed to project bus ${busId} onto route`);
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
    
    // Determine stop progression with GPS accuracy awareness
    const stopProgress = determineStopProgression(
      projection,
      route.stops,
      prevProgression,
      accuracy
    );
    
    // Calculate remaining distance along corridor
    const remainingDistanceKm = (projection.totalRouteLength - projection.cumulativeDistance) / 1000;
    
    // Calculate progress percentage
    const progressPercent = Math.round(
      (projection.cumulativeDistance / projection.totalRouteLength) * 100
    );
    
    // Calculate ETA
    const { etaMinutes, avgSpeedKmh } = calculateETA(remainingDistanceKm, busId);
    
    // Get stop names for display
    const currentStopId = stopProgress.currentStopIndex >= 0 ? route.stops[stopProgress.currentStopIndex] : null;
    const nextStopId = stopProgress.nextStopIndex >= 0 ? route.stops[stopProgress.nextStopIndex] : null;
    const currentStopName = currentStopId ? getStopNameById(currentStopId) : null;
    const nextStopName = nextStopId ? getStopNameById(nextStopId) : null;

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
      progressPercent,
      etaMinutes,
      avgSpeedKmh,
      cumulativeDistance: Math.round(projection.cumulativeDistance),
      totalRouteLength: Math.round(projection.totalRouteLength),
      lastProjectedPoint: projection.projectedPoint,
      lastUpdate: Date.now()
    };
    
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

module.exports = {
  computeBusProgression,
  hasProgressionChanged,
  projectOntoRouteCorridor,
  snapToRouteCorridor, // Route corridor locking for visual positioning
  haversineDistance,
  GPS_JITTER_THRESHOLD_METERS // Export for unified use
};
