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
  const prevState = trackingState.get(busId);
  const wasActive = prevState?.active === true;
  const nextActive = active === true;

  // Immutable state update
  const nextState = {
    active: nextActive,
    sos: prevState?.sos || false, // Preserve SOS flag
    updatedAt: Date.now()
  };
  trackingState.set(busId, nextState);

  console.log(`[TRACKING STATE] Bus ${busId}: ${nextActive ? "ACTIVE" : "INACTIVE"}`);

  // Emit BUS_OFFLINE only on explicit transition: active → inactive
  if (wasActive && !nextActive && io) {
    io.emit("BUS_OFFLINE", { busId });
    console.log(`[BUS_OFFLINE] Emitted for bus: ${busId}`);
  }

  return nextState;
};

/**
 * Set SOS state for a bus (does NOT disable tracking)
 * @param {string} busId - Bus identifier
 * @param {boolean} sosState - true = SOS active
 * @param {object} io - Socket.io instance (optional)
 * @returns {boolean} - true if SOS was set, false if tracking is off
 */
const setSosState = (busId, sosState, io = null) => {
  const prevState = trackingState.get(busId);
  const nextSos = sosState === true;

  // Bootstrap state if missing (emergency - always allow SOS)
  if (!prevState) {
    console.log(`[TRACKING STATE] Bus ${busId}: Bootstrapping state for SOS`);
    const nextState = {
      active: true,
      sos: nextSos,
      updatedAt: Date.now()
    };
    trackingState.set(busId, nextState);
    console.log(`[TRACKING STATE] Bus ${busId}: SOS ${nextSos ? "ACTIVE" : "CLEARED"}`);

    if (nextSos && io) {
      io.emit("SOS_TRIGGERED", { busId, timestamp: Date.now() });
      console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}`);
    }
    return true;
  }

  // Prevent SOS when tracking is explicitly stopped
  if (prevState?.active === false) {
    console.log(`[TRACKING STATE] Bus ${busId}: Cannot set SOS - tracking is stopped`);
    return false;
  }

  // Only allow SOS when tracking is explicitly active
  // Immutable update: preserve existing state, update only sos and timestamp
  const nextState = {
    active: prevState?.active === true, // Strict check - only true if explicitly active
    sos: nextSos,
    updatedAt: Date.now()
  };
  trackingState.set(busId, nextState);
  console.log(`[TRACKING STATE] Bus ${busId}: SOS ${nextSos ? "ACTIVE" : "CLEARED"}`);

  if (nextSos && io) {
    io.emit("SOS_TRIGGERED", { busId, timestamp: Date.now() });
    console.log(`[SOS_TRIGGERED] Emitted for bus: ${busId}`);
  }

  return true;
};

/**
 * Check if SOS is active for a bus
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if SOS is active
 */
const isSosActive = (busId) => {
  const state = trackingState.get(busId);
  return state?.sos === true;
};

/**
 * Check if tracking is active for a bus
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if tracking is active
 */
const isTrackingActive = (busId) => {
  const state = trackingState.get(busId);
  return state?.active === true;
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
 * Skips states already marked inactive (active === false)
 * @param {object} io - Socket.io instance (optional, used to emit BUS_OFFLINE)
 * @returns {string[]} - Array of busIds that were cleaned up
 */
const cleanupStaleState = (io = null) => {
  const now = Date.now();
  const staleBusIds = [];

  trackingState.forEach((state, busId) => {
    // Skip already inactive states - no duplicate cleanup needed
    if (state?.active === false) return;

    const lastUpdate = state?.updatedAt || 0;
    const isStale = now - lastUpdate > TRACKING_STATE_TTL_MS;

    if (isStale) {
      console.log(`[TRACKING STATE] Bus ${busId}: STALE (last update ${Math.round((now - lastUpdate) / 1000)}s ago)`);
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
  const state = trackingState.get(busId);
  // Inactive states are not "stale", they're intentionally stopped
  if (state?.active === false) return false;
  if (!state?.updatedAt) return true;

  const now = Date.now();
  return now - state.updatedAt > TRACKING_STATE_TTL_MS;
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
