// In-memory tracking state store
// Backend is single source of truth for tracking control

const trackingState = new Map();

// TTL timeout: 5 minutes of inactivity marks state as stale
const TRACKING_STATE_TTL_MS = 5 * 60 * 1000;

// Derived speed tracking for reliable movement state
const DERIVED_SPEED_SMOOTHING = 0.3; // Weight for new speed (0.3 new, 0.7 previous)
const MAX_REASONABLE_SPEED_KMH = 120; // Clamp GPS spikes to max reasonable speed

/**
 * Set tracking active state for a bus
 * @param {string} busId - Bus identifier
 * @param {boolean} state - true = active, false = inactive
 * @param {object} io - Socket.io instance (optional, used to emit BUS_OFFLINE)
 */
const setTrackingActive = (busId, active, io = null) => {
  const prevState = trackingState.get(busId) || {};
  const wasActive = prevState?.trackingActive === true;
  const nextActive = active === true;

  // When going inactive, clear speed and derived speed to prevent stale data
  const nextSpeed = nextActive ? (prevState?.speed || 0) : 0;
  const nextDerivedSpeed = nextActive ? (prevState?.derivedSpeed || 0) : 0;

  // Immutable state update with consistent keys
  const nextState = {
    trackingActive: nextActive,
    sos: prevState?.sos || false, // Preserve SOS flag
    lastUpdate: Date.now(),
    location: prevState?.location || null,
    speed: nextSpeed,
    derivedSpeed: nextDerivedSpeed,
    prevLat: null,
    prevLng: null,
    prevTimestamp: null
  };
  trackingState.set(busId, nextState);

  console.log(`[TRACKING STATE] Bus ${busId}: ${nextActive ? "ACTIVE" : "INACTIVE"}`);

  // On BUS_OFFLINE transition (active → inactive), delete from trackingState after emitting
  if (wasActive && !nextActive && io) {
    io.emit("BUS_OFFLINE", { busId });
    console.log(`[BUS_OFFLINE] Emitted for bus: ${busId}`);
    trackingState.delete(busId);
    console.log(`[TRACKING STATE] Bus ${busId}: deleted from trackingState`);
  }

  return nextState;
};

/**
 * Set SOS state for a bus (DISABLES tracking when active)
 * @param {string} busId - Bus identifier
 * @param {boolean} sosState - true = SOS active
 * @param {object} io - Socket.io instance (optional)
 * @param {object} location - { lat, lng } for SOS trigger (optional)
 * @returns {boolean} - true if SOS was set, false if tracking is off
 */
const setSosState = (busId, sosState, io = null, location = null) => {
  const prevState = trackingState.get(busId);
  const nextSos = sosState === true;

  // Bootstrap state if missing (emergency - always allow SOS)
  if (!prevState) {
    console.log(`[TRACKING STATE] Bus ${busId}: Bootstrapping state for SOS`);
    
    // Extract location with multiple fallback strategies
    const sosLat = location?.lat 
      ?? location?.latitude 
      ?? null;
    const sosLng = location?.lng 
      ?? location?.longitude 
      ?? null;
    
    const nextState = {
      trackingActive: !nextSos, // DISABLE tracking when SOS active
      sosActive: nextSos,
      sos: nextSos,
      lastUpdate: Date.now(),
      location: location || null
    };
    trackingState.set(busId, nextState);
    console.log(`[TRACKING STATE] Bus ${busId}: SOS ${nextSos ? "ACTIVE" : "CLEARED"}`);

    if (nextSos && io) {
      // Emit BUS_OFFLINE first (bus is no longer tracking)
      io.emit("BUS_OFFLINE", { busId });
      console.log(`[BUS_OFFLINE] Emitted for SOS bus: ${busId}`);
      // Then emit SOS_TRIGGERED with location
      io.emit("SOS_TRIGGERED", { 
        busId, 
        lat: sosLat,
        lng: sosLng,
        timestamp: Date.now() 
      });
      console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}, lat: ${sosLat}, lng: ${sosLng}`);
    }
    return true;
  }

  // === SOS TRIGGER (active → active) ===
  if (nextSos) {
    console.log(`[TRACKING STATE] Bus ${busId}: SOS TRIGGERED - disabling tracking`);
    
    // DISABLE tracking, enable SOS
    const nextState = {
      trackingActive: false,  // STOP tracking
      sosActive: true,
      sos: true,
      lastUpdate: Date.now(),
      location: location || prevState?.location || null,
      speed: 0
    };
    trackingState.set(busId, nextState);
    console.log(`[TRACKING STATE] Bus ${busId}: SOS ACTIVE, tracking DISABLED`);

    if (io) {
      // Emit BUS_OFFLINE first (remove from active buses)
      io.emit("BUS_OFFLINE", { busId });
      console.log(`[BUS_OFFLINE] Emitted for SOS bus: ${busId}`);
      
      // Extract location with multiple fallback strategies
      const sosLat = location?.lat 
        ?? prevState?.location?.lat 
        ?? prevState?.location?.latitude 
        ?? prevState?.lat 
        ?? null;
      const sosLng = location?.lng 
        ?? prevState?.location?.lng 
        ?? prevState?.location?.longitude 
        ?? prevState?.lng 
        ?? null;
      
      // Then emit SOS_TRIGGERED with location
      io.emit("SOS_TRIGGERED", { 
        busId, 
        lat: sosLat,
        lng: sosLng,
        timestamp: Date.now() 
      });
      console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}, lat: ${sosLat}, lng: ${sosLng}`);
    }
    return true;
  }

  // === SOS CLEAR (active → inactive) ===
  console.log(`[TRACKING STATE] Bus ${busId}: SOS CLEARED`);
  const nextState = {
    trackingActive: prevState?.trackingActive === true,
    sosActive: false,
    sos: false,
    lastUpdate: Date.now(),
    location: prevState?.location || null,
    speed: prevState?.speed || 0
  };
  trackingState.set(busId, nextState);
  console.log(`[TRACKING STATE] Bus ${busId}: SOS CLEARED`);

  if (io) {
    io.emit("SOS_CLEARED", { busId, timestamp: Date.now() });
    console.log(`[SOS_CLEARED] Emitted for bus: ${busId}`);
  }

  return true;
};

/**
 * Check if SOS is active for a bus
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if SOS is active
 */
const isSosActive = (busId) => {
  const state = trackingState.get(busId) || {};
  return state?.sos === true;
};

/**
 * Check if tracking is active for a bus
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if tracking is active
 */
const isTrackingActive = (busId) => {
  const state = trackingState.get(busId) || {};
  return state?.trackingActive === true;
};

/**
 * Get full tracking state for a bus
 * @param {string} busId - Bus identifier
 * @returns {object|null} - state object with 'active' property or null
 */
const getTrackingState = (busId) => {
  return trackingState.get(busId) || null;
};

/**
 * Check if tracking state exists for a bus (raw Map check)
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if state exists in Map
 */
const hasTrackingState = (busId) => {
  return trackingState.has(busId);
};

/**
 * Remove tracking state for a bus (cleanup)
 * @param {string} busId - Bus identifier
 */
const clearTrackingState = (busId) => {
  trackingState.delete(busId);
  console.log(`[TRACKING STATE] Bus ${busId}: cleared`);
};

/**
 * Get all active tracking states (for debugging)
 * @returns {Object} - Object with busId -> state mapping
 */
const getAllTrackingStates = () => {
  const states = {};
  trackingState.forEach((value, key) => {
    states[key] = value;
  });
  return states;
};

/**
 * Check and cleanup stale tracking states
 * Skips states already marked inactive (trackingActive === false)
 * @param {object} io - Socket.io instance (optional, used to emit BUS_OFFLINE)
 * @returns {string[]} - Array of busIds that were cleaned up
 */
const cleanupStaleState = (io = null) => {
  const now = Date.now();
  const staleBusIds = [];

  trackingState.forEach((state, busId) => {
    // Skip already inactive states - no duplicate cleanup needed
    if (state?.trackingActive === false) return;

    const lastUpdate = state?.lastUpdate || 0;
    const isStale = now - lastUpdate > TRACKING_STATE_TTL_MS;

    if (isStale) {
      console.log(`[TRACKING STATE] Bus ${busId}: STALE (last update ${Math.round((now - lastUpdate) / 1000)}s ago)`);
      // Mark inactive, emit BUS_OFFLINE, and delete from trackingState
      setTrackingActive(busId, false, io);
      staleBusIds.push(busId);
    }
  });

  return staleBusIds;
};

/**
 * Check if tracking state is stale (for single bus check)
 * Only checks active states - inactive states are not "stale", just stopped
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if state is stale
 */
const isStateStale = (busId) => {
  const state = trackingState.get(busId) || {};
  // Inactive states are not "stale", they're intentionally stopped
  if (state?.trackingActive === false) return false;
  if (!state?.lastUpdate) return true;

  const now = Date.now();
  return now - state.lastUpdate > TRACKING_STATE_TTL_MS;
};

/**
 * Generate unique trip ID for route assignments
 * Format: TRIP_{timestamp}_{random}
 */
const generateTripId = () => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TRIP_${timestamp}_${random}`;
};

/**
 * Set route assignment for a bus
 * @param {string} busId - Bus identifier
 * @param {object} routeData - { routeId, routeName, routeColor, direction }
 * @returns {object} - Updated state with tripId
 */
const setBusRoute = (busId, routeData) => {
  const prevState = trackingState.get(busId) || {};

  // Clear progression state if route changed
  if (prevState.routeId && prevState.routeId !== routeData.routeId) {
    clearBusProgression(busId);
    console.log(`[TRACKING STATE] Bus ${busId}: Progression cleared (route switch ${prevState.routeId} → ${routeData.routeId})`);
  }

  const tripId = generateTripId();
  
  const nextState = {
    ...prevState,
    routeId: routeData.routeId,
    routeName: routeData.routeName,
    routeColor: routeData.routeColor,
    direction: routeData.direction,
    tripId: tripId,
    currentStopIndex: 0, // Future-ready for stop progression
    lastUpdate: Date.now(),
  };
  
  trackingState.set(busId, nextState);
  console.log(`[TRACKING STATE] Bus ${busId}: Route assigned - ${routeData.routeName} (${routeData.direction}), Trip: ${tripId}`);
  
  return { ...nextState, tripId };
};

/**
 * Get route info for a bus
 * @param {string} busId - Bus identifier
 * @returns {object|null} - Route data or null
 */
const getBusRoute = (busId) => {
  const state = trackingState.get(busId);
  if (!state || !state.routeId) return null;
  
  return {
    routeId: state.routeId,
    routeName: state.routeName,
    routeColor: state.routeColor,
    direction: state.direction,
    tripId: state.tripId,
    currentStopIndex: state.currentStopIndex,
  };
};

/**
 * Clear route assignment for a bus (end shift)
 * @param {string} busId - Bus identifier
 */
const clearBusRoute = (busId) => {
  const prevState = trackingState.get(busId);
  if (!prevState) return;
  
  const nextState = {
    ...prevState,
    routeId: null,
    routeName: null,
    routeColor: null,
    direction: null,
    tripId: null,
    currentStopIndex: null,
    lastUpdate: Date.now(),
  };
  
  trackingState.set(busId, nextState);
  console.log(`[TRACKING STATE] Bus ${busId}: Route cleared (shift ended)`);
};

/**
 * Set progression state for a bus trip
 * @param {string} busId - Bus identifier
 * @param {object} progression - { currentStopIndex, nextStopIndex, passedStopIds, cumulativeDistance, remainingDistanceKm, progressPercent, etaMinutes, speedSamples }
 */
const setBusProgression = (busId, progression) => {
  const prevState = trackingState.get(busId) || {};
  
  const nextState = {
    ...prevState,
    progression: {
      ...prevState.progression,
      ...progression,
      lastUpdate: Date.now(),
    },
    lastUpdate: Date.now(),
  };
  
  trackingState.set(busId, nextState);
};

/**
 * Get progression state for a bus
 * @param {string} busId - Bus identifier
 * @returns {object|null} - Progression data or null
 */
const getBusProgression = (busId) => {
  const state = trackingState.get(busId);
  return state?.progression || null;
};

/**
 * Clear progression state for a bus
 * @param {string} busId - Bus identifier
 */
const clearBusProgression = (busId) => {
  const prevState = trackingState.get(busId);
  if (!prevState) return;
  
  const nextState = {
    ...prevState,
    progression: null,
    lastUpdate: Date.now(),
  };
  
  trackingState.set(busId, nextState);
  console.log(`[TRACKING STATE] Bus ${busId}: Progression cleared`);
};

/**
 * Add speed sample for rolling average calculation
 * @param {string} busId - Bus identifier
 * @param {number} speed - Speed in km/h
 * @returns {number[]} - Updated speed samples array
 */
const addSpeedSample = (busId, speed) => {
  const prevState = trackingState.get(busId) || {};
  const progression = prevState.progression || {};
  
  // Keep last 10 speed samples for rolling average
  const samples = progression.speedSamples || [];
  samples.push(speed);
  if (samples.length > 10) samples.shift();
  
  setBusProgression(busId, { speedSamples: samples });
  return samples;
};

/**
 * Calculate rolling average speed
 * @param {string} busId - Bus identifier
 * @returns {number} - Average speed in km/h
 */
const getRollingAverageSpeed = (busId) => {
  const progression = getBusProgression(busId);
  if (!progression?.speedSamples || progression.speedSamples.length === 0) {
    return 15; // Default fallback speed (15 km/h)
  }

  const samples = progression.speedSamples;
  const sum = samples.reduce((a, b) => a + b, 0);
  return sum / samples.length;
};

/**
 * Compute derived speed from position changes (reliable movement detection)
 * @param {string} busId - Bus identifier
 * @param {number} lat - Current latitude
 * @param {number} lng - Current longitude
 * @param {number} timestamp - Current timestamp
 * @returns {object} - { derivedSpeed, updatedState }
 */
const computeDerivedSpeed = (busId, lat, lng, timestamp) => {
  const prevState = trackingState.get(busId) || {};

  const prevLat = prevState.prevLat;
  const prevLng = prevState.prevLng;
  const prevTimestamp = prevState.prevTimestamp;
  const prevDerivedSpeed = prevState.derivedSpeed || 0;

  let currentDerivedSpeed = prevDerivedSpeed;

  // Compute speed from position change if we have previous data
  if (prevLat !== null && prevLng !== null && prevTimestamp !== null) {
    const timeDiffSec = (timestamp - prevTimestamp) / 1000;

    // Only compute if reasonable time elapsed (avoid division by zero and noise)
    if (timeDiffSec > 0.5 && timeDiffSec < 60) {
      const distanceMeters = haversineDistance(prevLat, prevLng, lat, lng);
      const speedMps = distanceMeters / timeDiffSec;
      const speedKmh = speedMps * 3.6;

      // Weighted smoothing: 70% previous, 30% new
      currentDerivedSpeed = (prevDerivedSpeed * 0.7) + (speedKmh * DERIVED_SPEED_SMOOTHING);

      // Fix #2: Clamp to prevent GPS spikes
      currentDerivedSpeed = Math.min(currentDerivedSpeed, MAX_REASONABLE_SPEED_KMH);

      console.log(`[DERIVED SPEED] Bus ${busId}: ${speedKmh.toFixed(2)} km/h (raw), ${currentDerivedSpeed.toFixed(2)} km/h (clamped)`);
    }
  }

  // Update state with new position data
  const nextState = {
    ...prevState,
    derivedSpeed: currentDerivedSpeed,
    prevLat: lat,
    prevLng: lng,
    prevTimestamp: timestamp
  };

  trackingState.set(busId, nextState);

  return {
    derivedSpeed: currentDerivedSpeed,
    updatedState: nextState
  };
};

/**
 * Haversine distance calculation (meters)
 * @param {number} lat1 - Latitude 1
 * @param {number} lng1 - Longitude 1
 * @param {number} lat2 - Latitude 2
 * @param {number} lng2 - Longitude 2
 * @returns {number} - Distance in meters
 */
const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

module.exports = {
  setTrackingActive,
  setSosState,
  isTrackingActive,
  isSosActive,
  getTrackingState,
  hasTrackingState,
  computeDerivedSpeed,
  haversineDistance,
  isStateStale,
  cleanupStaleState,
  clearTrackingState,
  getAllTrackingStates,
  setBusRoute,
  getBusRoute,
  clearBusRoute,
  generateTripId,
  trackingState, // Export for raw access if needed
  TRACKING_STATE_TTL_MS
};
