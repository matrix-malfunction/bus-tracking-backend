// In-memory tracking state store
// Backend is single source of truth for tracking control

const trackingState = new Map();

/**
 * Set tracking active state for a bus
 * @param {string} busId - Bus identifier
 * @param {boolean} state - true = active, false = inactive
 * @param {object} io - Socket.io instance (optional, used to emit BUS_OFFLINE)
 */
const setTrackingActive = (busId, state, io = null) => {
  trackingState.set(busId, state);
  console.log(`[TRACKING STATE] Bus ${busId}: ${state ? "ACTIVE" : "INACTIVE"}`);

  // Emit BUS_OFFLINE to remove ghost markers from all clients
  if (!state && io) {
    io.emit("BUS_OFFLINE", { busId });
    console.log(`[BUS_OFFLINE] Emitted for bus: ${busId}`);
  }
};

/**
 * Check if tracking is active for a bus
 * @param {string} busId - Bus identifier
 * @returns {boolean} - true if tracking is active
 */
const isTrackingActive = (busId) => {
  return trackingState.get(busId) === true;
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

module.exports = {
  setTrackingActive,
  isTrackingActive,
  clearTrackingState,
  getAllTrackingStates
};
