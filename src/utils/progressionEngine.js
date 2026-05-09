/**
 * Bus Stop Progression Engine
 * 
 * Backend-driven progression calculation with GPS jitter protection.
 * Projects bus position onto route corridor and computes stop progression.
 */

const routes = require("../../data/routes");
const { getBusProgression, setBusProgression, addSpeedSample, getRollingAverageSpeed } = require("./trackingState");

// Hysteresis thresholds
const MIN_ADVANCEMENT_METERS = 50; // Must advance 50m before updating stop index
const GPS_JITTER_THRESHOLD_METERS = 20; // Ignore movements less than 20m
const MIN_SPEED_KMH = 5; // Minimum operational speed for ETA calculation

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
 */
function determineStopProgression(projection, routeStops, stopCoords, prevProgression) {
  const { cumulativeDistance, totalRouteLength } = projection;
  const prevStopIndex = prevProgression?.currentStopIndex ?? -1;
  
  let currentStopIndex = -1;
  let nextStopIndex = -1;
  let passedStopIds = [];
  
  // Calculate distance to each stop along route
  const stopDistances = stopCoords.map((coord, index) => {
    // Find closest point on route to this stop
    const stopProjection = projectOntoRouteCorridor(coord[0], coord[1], [coord]);
    return {
      index,
      stopId: routeStops[index],
      distance: cumulativeDistance // Approximation - stops should be near route
    };
  });
  
  // Find current stop (last stop we've passed)
  for (let i = 0; i < stopDistances.length; i++) {
    // A stop is considered "passed" if we've traveled past its position
    const stopPositionRatio = i / (stopDistances.length - 1 || 1);
    const currentPositionRatio = cumulativeDistance / totalRouteLength;
    
    if (currentPositionRatio >= stopPositionRatio - 0.05) { // 5% buffer
      currentStopIndex = i;
      passedStopIds.push(routeStops[i]);
    }
  }
  
  // GPS Jitter Protection: Hysteresis
  // Only advance stop index, never go backwards
  if (prevStopIndex > currentStopIndex) {
    // GPS jitter trying to move backwards - lock to previous
    currentStopIndex = prevStopIndex;
    // Recalculate passed stops
    passedStopIds = routeStops.slice(0, currentStopIndex + 1);
  }
  
  // Determine next stop
  nextStopIndex = currentStopIndex + 1;
  if (nextStopIndex >= routeStops.length) {
    nextStopIndex = -1; // End of route
  }
  
  return {
    currentStopIndex,
    nextStopIndex,
    passedStopIds,
    remainingStops: routeStops.length - currentStopIndex - 1
  };
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
function computeBusProgression(busId, busLat, busLng, speedKmh) {
  try {
    // Get current tracking state
    const trackingState = require("./trackingState").trackingState;
    const state = trackingState.get(busId);
    
    if (!state || !state.routeId) {
      return null; // No route assigned
    }
    
    // Load route data
    const route = routes.find(r => r.id === state.routeId);
    if (!route) {
      console.log(`[Progression] Route not found: ${state.routeId}`);
      return null;
    }
    
    // Get previous progression for hysteresis
    const prevProgression = getBusProgression(busId);
    
    // Add speed sample for rolling average
    addSpeedSample(busId, speedKmh);
    
    // Project bus position onto route corridor
    const projection = projectOntoRouteCorridor(
      busLat,
      busLng,
      route.coordinates
    );
    
    if (!projection) {
      console.log(`[Progression] Failed to project bus ${busId} onto route`);
      return null;
    }
    
    // GPS Jitter Check: Ignore tiny movements
    if (prevProgression?.lastProjectedPoint) {
      const moveDistance = haversineDistance(
        prevProgression.lastProjectedPoint[0],
        prevProgression.lastProjectedPoint[1],
        projection.projectedPoint[0],
        projection.projectedPoint[1]
      );
      
      if (moveDistance < GPS_JITTER_THRESHOLD_METERS) {
        // Too small to process - return previous progression with updated time
        return {
          ...prevProgression,
          lastUpdate: Date.now(),
          jitterFiltered: true
        };
      }
    }
    
    // Determine stop progression
    const stopProgress = determineStopProgression(
      projection,
      route.stops,
      route.coordinates,
      prevProgression
    );
    
    // Calculate remaining distance along corridor
    const remainingDistanceKm = (projection.totalRouteLength - projection.cumulativeDistance) / 1000;
    
    // Calculate progress percentage
    const progressPercent = Math.round(
      (projection.cumulativeDistance / projection.totalRouteLength) * 100
    );
    
    // Calculate ETA
    const { etaMinutes, avgSpeedKmh } = calculateETA(remainingDistanceKm, busId);
    
    // Build progression result
    const progression = {
      busId,
      tripId: state.tripId,
      routeId: state.routeId,
      currentStopIndex: stopProgress.currentStopIndex,
      nextStopIndex: stopProgress.nextStopIndex,
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
    
    return progression;
  } catch (err) {
    console.error(`[Progression] Error computing for bus ${busId}:`, err.message);
    return null;
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
  haversineDistance
};
