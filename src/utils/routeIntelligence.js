/**
 * Route Intelligence Utilities - Enhanced
 * 
 * Provides:
 * - Bus-to-route matching with confidence
 * - Route stability (prevent switching)
 * - Next stop detection with progression lock
 * - Smooth ETA calculation
 * - Traffic simulation
 */

const EARTH_RADIUS_KM = 6371;
const ROUTE_CONFIDENCE_THRESHOLD_KM = 0.2; // 200m max distance from route
const ROUTE_SWITCH_HYSTERESIS_KM = 0.15; // Must be 150m closer to switch
const MIN_SPEED_KMH = 5; // Below this, use fallback
const FALLBACK_SPEED_KMH = 25; // Average bus speed

// Track state per bus (in production, use Redis or DB)
const busRouteState = new Map(); // busId -> { routeId, lastStopIndex, speedHistory, lastUpdate }

// Haversine distance
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// Find nearest point on line segment
function nearestPointOnSegment(lat, lng, segStart, segEnd) {
  const lat1 = segStart.lat;
  const lng1 = segStart.lng;
  const lat2 = segEnd.lat;
  const lng2 = segEnd.lng;

  const A = lat - lat1;
  const B = lng - lng1;
  const C = lat2 - lat1;
  const D = lng2 - lng1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;

  if (lenSq !== 0) {
    param = dot / lenSq;
  }

  let nearestLat, nearestLng;

  if (param < 0) {
    nearestLat = lat1;
    nearestLng = lng1;
  } else if (param > 1) {
    nearestLat = lat2;
    nearestLng = lng2;
  } else {
    nearestLat = lat1 + param * C;
    nearestLng = lng1 + param * D;
  }

  const distance = haversineDistanceKm(lat, lng, nearestLat, nearestLng);

  return { lat: nearestLat, lng: nearestLng, distance, param };
}

// Check if current time is peak hours (simplified)
function isPeakHour() {
  const hour = new Date().getHours();
  // Morning: 7-10, Evening: 17-20
  return (hour >= 7 && hour <= 10) || (hour >= 17 && hour <= 20);
}

// Get traffic multiplier
function getTrafficMultiplier() {
  return isPeakHour() ? 1.2 : 0.9;
}

// Smooth speed with history
function getSmoothedSpeed(busId, currentSpeed) {
  const state = busRouteState.get(busId) || { speedHistory: [] };
  
  // Fallback for low speeds
  let effectiveSpeed = currentSpeed;
  if (!currentSpeed || currentSpeed < MIN_SPEED_KMH) {
    effectiveSpeed = FALLBACK_SPEED_KMH;
  }
  
  // Add to history
  state.speedHistory.push(effectiveSpeed);
  if (state.speedHistory.length > 5) {
    state.speedHistory.shift();
  }
  
  // Weighted average: 60% previous avg, 40% current
  const prevAvg = state.speedHistory.length > 1
    ? state.speedHistory.slice(0, -1).reduce((a, b) => a + b, 0) / (state.speedHistory.length - 1)
    : effectiveSpeed;
  
  const smoothed = prevAvg * 0.6 + effectiveSpeed * 0.4;
  
  state.speedHistory = state.speedHistory;
  busRouteState.set(busId, state);
  
  return smoothed;
}

// Match bus to route with confidence and stability
function matchBusToRoute(busLat, busLng, route, busId) {
  if (!route?.stops || route.stops.length < 2) return null;

  let minDistance = Infinity;
  let nearestSegment = null;
  let nearestParam = 0;
  let segmentIndex = -1;

  for (let i = 0; i < route.stops.length - 1; i++) {
    const segStart = route.stops[i];
    const segEnd = route.stops[i + 1];

    const result = nearestPointOnSegment(busLat, busLng, segStart, segEnd);

    if (result.distance < minDistance) {
      minDistance = result.distance;
      nearestSegment = { start: segStart, end: segEnd, index: i };
      nearestParam = result.param;
      segmentIndex = i;
    }
  }

  if (!nearestSegment) return null;

  // 1. CONFIDENCE CHECK: Only match if within threshold
  if (minDistance > ROUTE_CONFIDENCE_THRESHOLD_KM) {
    return null; // Too far from route, reject
  }

  // 2. ROUTE STABILITY: Check against previous route assignment
  const state = busRouteState.get(busId);
  if (state?.routeId && state.routeId !== route._id.toString()) {
    // Currently on different route, check if new route is significantly better
    const prevDistance = state.lastDistanceFromRoute || Infinity;
    const improvement = prevDistance - minDistance;
    
    // Only switch if new route is at least 150m closer
    if (improvement < ROUTE_SWITCH_HYSTERESIS_KM) {
      return null; // Stick with current route
    }
  }

  // Determine direction
  const isMovingForward = nearestParam > 0.5;

  return {
    routeId: route._id.toString(),
    routeName: route.routeName,
    segmentIndex,
    progress: nearestParam,
    distanceFromRoute: minDistance,
    isMovingForward,
    nearestSegment,
    isConfident: minDistance <= ROUTE_CONFIDENCE_THRESHOLD_KM,
  };
}

// Find next upcoming stop with progression lock
function findNextStop(busLat, busLng, route, routeMatch, busId, visitedStops = new Set()) {
  if (!route?.stops || !routeMatch) return null;

  const { segmentIndex, isMovingForward } = routeMatch;
  const stops = route.stops;

  // Get state to check last known stop index
  const state = busRouteState.get(busId) || {};
  const lastStopIndex = state.lastStopIndex || -1;

  let nextStopIndex;

  if (isMovingForward) {
    // Bus is moving toward end of current segment
    nextStopIndex = segmentIndex + 2;
  } else {
    // Bus is moving backward
    nextStopIndex = segmentIndex;
  }

  // 4. STOP PROGRESSION LOCK: Never go backwards in stops
  if (nextStopIndex < lastStopIndex) {
    nextStopIndex = lastStopIndex;
  }

  // Find first unvisited stop from current position
  while (nextStopIndex < stops.length && visitedStops.has(stops[nextStopIndex].name)) {
    nextStopIndex++;
  }

  // Update state with new stop index (only forward)
  if (nextStopIndex > lastStopIndex) {
    state.lastStopIndex = nextStopIndex;
    busRouteState.set(busId, state);
  }

  if (nextStopIndex >= stops.length) {
    return { name: "End of Route", isEnd: true, index: stops.length };
  }

  return {
    stop: stops[nextStopIndex],
    index: nextStopIndex,
    stopsAway: nextStopIndex - segmentIndex - 1,
  };
}

// Calculate distance along route to next stop
function calculateRouteDistance(busLat, busLng, route, routeMatch, nextStopInfo) {
  if (!route?.stops || !routeMatch || !nextStopInfo) return null;

  const { segmentIndex, progress, nearestSegment } = routeMatch;
  const stops = route.stops;

  // Distance from current position to end of current segment
  const remainingInSegment = haversineDistanceKm(
    busLat,
    busLng,
    nearestSegment.end.lat,
    nearestSegment.end.lng
  );

  // Sum distance of all segments to next stop
  let totalDistance = remainingInSegment;

  for (let i = segmentIndex + 1; i < nextStopInfo.index; i++) {
    totalDistance += haversineDistanceKm(
      stops[i].lat,
      stops[i].lng,
      stops[i + 1].lat,
      stops[i + 1].lng
    );
  }

  return totalDistance;
}

// Calculate route-based ETA with smoothing and traffic
function calculateRouteETA(busLat, busLng, busSpeed, route, routeMatch, nextStopInfo, busId) {
  const routeDistance = calculateRouteDistance(busLat, busLng, route, routeMatch, nextStopInfo);

  if (!routeDistance) {
    return null;
  }

  // 3. ETA SMOOTHING: Use smoothed speed with fallback
  const smoothedSpeed = getSmoothedSpeed(busId, busSpeed);

  // Calculate base ETA
  let etaMinutes = (routeDistance / smoothedSpeed) * 60;

  // 5. TRAFFIC SIMULATION: Apply time-based multiplier
  const trafficMultiplier = getTrafficMultiplier();
  etaMinutes = etaMinutes * trafficMultiplier;

  return {
    etaMinutes: Math.ceil(etaMinutes),
    routeDistanceKm: routeDistance,
    stopsAway: nextStopInfo?.stopsAway ?? 0,
    smoothedSpeedKmh: Math.round(smoothedSpeed * 10) / 10,
    trafficMultiplier,
  };
}

// Get full route intelligence for a bus
function getBusRouteIntelligence(bus, route, busId) {
  if (!bus?.latitude || !bus?.longitude || !route) {
    return null;
  }

  const busIdStr = busId || bus.busId || bus._id;
  if (!busIdStr) return null;

  // Initialize state if needed
  if (!busRouteState.has(busIdStr)) {
    busRouteState.set(busIdStr, { routeId: null, lastStopIndex: -1, speedHistory: [], lastUpdate: Date.now() });
  }

  const routeMatch = matchBusToRoute(bus.latitude, bus.longitude, route, busIdStr);
  if (!routeMatch) return null;

  // Update state with current route assignment
  const state = busRouteState.get(busIdStr);
  state.routeId = routeMatch.routeId;
  state.lastDistanceFromRoute = routeMatch.distanceFromRoute;
  state.lastUpdate = Date.now();
  busRouteState.set(busIdStr, state);

  const nextStopInfo = findNextStop(
    bus.latitude,
    bus.longitude,
    route,
    routeMatch,
    busIdStr,
    bus.visitedStops
  );

  const etaInfo = calculateRouteETA(
    bus.latitude,
    bus.longitude,
    bus.speed || bus.calculatedSpeed,
    route,
    routeMatch,
    nextStopInfo,
    busIdStr
  );

  return {
    routeId: routeMatch.routeId,
    routeName: route.routeName,
    segmentIndex: routeMatch.segmentIndex,
    progress: routeMatch.progress,
    isMovingForward: routeMatch.isMovingForward,
    distanceFromRoute: routeMatch.distanceFromRoute,
    isConfident: routeMatch.isConfident,
    nextStop: nextStopInfo?.stop?.name || "Unknown",
    nextStopLocation: nextStopInfo?.stop,
    stopsAway: etaInfo?.stopsAway ?? 0,
    etaMinutes: etaInfo?.etaMinutes,
    routeDistanceKm: etaInfo?.routeDistanceKm,
    smoothedSpeedKmh: etaInfo?.smoothedSpeedKmh,
    trafficMultiplier: etaInfo?.trafficMultiplier,
    allStops: route.stops,
  };
}

// Cleanup stale bus state (call periodically)
function cleanupStaleBusState(maxAgeMs = 30 * 60 * 1000) { // 30 min default
  const now = Date.now();
  for (const [busId, state] of busRouteState.entries()) {
    if (now - state.lastUpdate > maxAgeMs) {
      busRouteState.delete(busId);
    }
  }
}

// Generate polyline data for map
function getRoutePolyline(route) {
  if (!route?.stops) return [];
  return route.stops.map((stop) => [stop.lat, stop.lng]);
}

module.exports = {
  matchBusToRoute,
  findNextStop,
  calculateRouteDistance,
  calculateRouteETA,
  getBusRouteIntelligence,
  getRoutePolyline,
  cleanupStaleBusState,
  haversineDistanceKm,
};
