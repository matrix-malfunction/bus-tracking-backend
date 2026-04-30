/**
 * Speed and heading calculation utilities
 * Backend single source of truth for accurate real-time metrics
 */

const R = 6371000; // Earth radius in meters

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Calculate speed using Haversine formula
 * @param {Object} prev - Previous position { lat, lng, timestamp, speed }
 * @param {Object} curr - Current position { lat, lng, timestamp }
 * @returns {number} Speed in km/h
 */
function calculateSpeed(prev, curr) {
  if (!prev || !prev.lat || !prev.lng) return 0;

  const dLat = toRad(curr.lat - prev.lat);
  const dLng = toRad(curr.lng - prev.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(prev.lat)) *
      Math.cos(toRad(curr.lat)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // meters

  // Guard: ensure time is progressing
  if (!prev.lastUpdate || curr.lastUpdate <= prev.lastUpdate) return prev.speed || 0;

  const timeDiff = (curr.lastUpdate - prev.lastUpdate) / 1000; // seconds

  // Ignore updates less than 1 second apart
  if (timeDiff < 1) return prev.speed || 0;

  // Ignore GPS noise (less than 5 meters)
  if (distance < 5) return prev.speed || 0;

  let speed = (distance / timeDiff) * 3.6; // convert to km/h

  // Clamp unrealistic speeds (over 120 km/h)
  if (speed > 120) return prev.speed || 0;

  return speed;
}

/**
 * Smooth speed using moving average
 * @param {number[]} history - Array of previous speeds
 * @param {number} newSpeed - New calculated speed
 * @returns {Object} { speed: smoothedSpeed, history: updatedHistory }
 */
function smoothSpeed(history = [], newSpeed) {
  const MAX_HISTORY = 5;
  const arr = [...history, newSpeed].slice(-MAX_HISTORY);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;

  return { speed: avg, history: arr };
}

/**
 * Calculate heading (bearing) between two points
 * @param {Object} prev - Previous position { lat, lng }
 * @param {Object} curr - Current position { lat, lng }
 * @returns {number} Heading in degrees (0-360)
 */
function calculateHeading(prev, curr) {
  if (!prev || !prev.lat || !prev.lng) return 0;

  const y =
    Math.sin(toRad(curr.lng - prev.lng)) *
    Math.cos(toRad(curr.lat));

  const x =
    Math.cos(toRad(prev.lat)) *
      Math.sin(toRad(curr.lat)) -
    Math.sin(toRad(prev.lat)) *
      Math.cos(toRad(curr.lat)) *
      Math.cos(toRad(curr.lng - prev.lng));

  let brng = Math.atan2(y, x);
  return ((brng * 180) / Math.PI + 360) % 360;
}

/**
 * Smooth heading using weighted average
 * @param {number} prevHeading - Previous heading
 * @param {number} newHeading - New calculated heading
 * @returns {number} Smoothed heading
 */
function smoothHeading(prevHeading, newHeading) {
  if (!prevHeading) return newHeading;
  // 70% previous, 30% new for stability
  return (prevHeading * 0.7 + newHeading * 0.3 + 360) % 360;
}

module.exports = {
  calculateSpeed,
  smoothSpeed,
  calculateHeading,
  smoothHeading,
};
