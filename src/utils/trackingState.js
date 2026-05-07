// In-memory tracking state store
// Backend is single source of truth for tracking control

const trackingState = new Map();

// TTL timeout: 5 minutes of inactivity marks state as stale
const TRACKING_STATE_TTL_MS = 5 * 60 * 1000;

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

  // When going inactive, clear speed to prevent stale data
  const nextSpeed = nextActive ? (prevState?.speed || 0) : 0;

  // Immutable state update with consistent keys
  const nextState = {
    trackingActive: nextActive,
    sos: prevState?.sos || false, // Preserve SOS flag
    lastUpdate: Date.now(),
    location: prevState?.location || null,
    speed: nextSpeed
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
        lat: location?.lat,
        lng: location?.lng,
        timestamp: Date.now() 
      });
      console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}`);
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
      // Then emit SOS_TRIGGERED with location
      io.emit("SOS_TRIGGERED", { 
        busId, 
        lat: location?.lat || prevState?.location?.lat,
        lng: location?.lng || prevState?.location?.lng,
        timestamp: Date.now() 
      });
      console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}`);
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

module.exports = {
  setTrackingActive,
  setSosState,
  isTrackingActive,
  isSosActive,
  getTrackingState,
  hasTrackingState,
  isStateStale,
  cleanupStaleState,
  clearTrackingState,
  getAllTrackingStates,
  trackingState, // Export for raw access if needed
  TRACKING_STATE_TTL_MS
};
