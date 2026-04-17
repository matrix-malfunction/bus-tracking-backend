const EARTH_RADIUS_KM = 6371;
const ARRIVING_DISTANCE_KM = 0.05;
const MAX_REALISTIC_SPEED_KMH = 120;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const aLat = toNumber(lat1);
  const aLng = toNumber(lng1);
  const bLat = toNumber(lat2);
  const bLng = toNumber(lng2);

  if (aLat === null || aLng === null || bLat === null || bLng === null) {
    return 0;
  }

  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const rLat1 = toRadians(aLat);
  const rLat2 = toRadians(bLat);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const angularDistance = 2 * Math.asin(Math.sqrt(haversine));

  return EARTH_RADIUS_KM * angularDistance;
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;

  const lat = toNumber(point.latitude ?? point.lat);
  const lng = toNumber(point.longitude ?? point.lng);

  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function computeSpeedKmh(prevPoint, currPoint) {
  const prev = normalizePoint(prevPoint);
  const curr = normalizePoint(currPoint);
  if (!prev || !curr) return 0;

  const prevTime = new Date(prevPoint?.timestamp ?? prevPoint?.updatedAt ?? 0).getTime();
  const currTime = new Date(currPoint?.timestamp ?? currPoint?.updatedAt ?? 0).getTime();
  if (!Number.isFinite(prevTime) || !Number.isFinite(currTime)) return 0;

  const deltaHours = (currTime - prevTime) / (1000 * 60 * 60);
  if (deltaHours <= 0) return 0;

  const distanceKm = haversineKm(prev.lat, prev.lng, curr.lat, curr.lng);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;

  const speedKmh = distanceKm / deltaHours;
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return 0;

  return Math.min(speedKmh, MAX_REALISTIC_SPEED_KMH);
}

function findNearestForwardStop(stops, busPoint, lastStopIndex = 0) {
  if (!Array.isArray(stops) || stops.length === 0) return null;

  const bus = normalizePoint(busPoint);
  if (!bus) return null;

  const minIndex = Number.isFinite(Number(lastStopIndex)) ? Number(lastStopIndex) : 0;

  const normalizedStops = stops
    .map((stop, index) => {
      const normalized = normalizePoint(stop);
      if (!normalized) return null;
      return {
        ...stop,
        name: stop?.name || `Stop ${index + 1}`,
        lat: normalized.lat,
        lng: normalized.lng,
        order: Number.isFinite(Number(stop?.order)) ? Number(stop.order) : index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  if (normalizedStops.length === 0) return null;

  const forwardStops = normalizedStops.filter((stop) => stop.order >= minIndex);
  const candidates = forwardStops.length > 0 ? forwardStops : normalizedStops;

  let nearest = null;
  for (const stop of candidates) {
    const distanceKm = haversineKm(bus.lat, bus.lng, stop.lat, stop.lng);
    if (!nearest || distanceKm < nearest.distanceKm) {
      nearest = { stop, distanceKm };
    }
  }

  if (!nearest) return null;

  return {
    nearestStop: nearest.stop.name,
    distanceKm: nearest.distanceKm,
    stopIndex: nearest.stop.order,
    stop: nearest.stop,
  };
}

function computeEtaMinutes(distanceKm, speedKmh) {
  const distance = toNumber(distanceKm);
  const speed = toNumber(speedKmh);

  if (distance === null) return null;
  if (distance <= ARRIVING_DISTANCE_KM) return "Arriving";
  if (speed === null || speed <= 0) return "Stopped";

  const safeSpeed = Math.min(speed, MAX_REALISTIC_SPEED_KMH);
  const etaMinutes = (distance / safeSpeed) * 60;
  if (!Number.isFinite(etaMinutes)) return "Stopped";

  return Math.max(1, Math.round(etaMinutes));
}

module.exports = {
  haversineKm,
  computeSpeedKmh,
  findNearestForwardStop,
  computeEtaMinutes,
};
