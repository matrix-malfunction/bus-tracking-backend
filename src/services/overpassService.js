/**
 * Overpass API Service for fetching bus stops from OpenStreetMap
 * Caches results for 24 hours to reduce API calls
 */

const https = require('https');

// Cache configuration
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_RESULTS = 500; // Limit results to prevent UI overload

let cache = {
  data: null,
  timestamp: 0
};

// Bounding box for Thiruvallur + Vellore region (Tamil Nadu)
// Thiruvallur: ~13.12, 79.91
// Vellore: ~12.92, 79.13
const BOUNDING_BOX = {
  minLat: 12.5,
  maxLat: 13.3,
  minLng: 78.8,
  maxLng: 80.2
};

/**
 * Fetch bus stops from Overpass API for Thiruvallur and Vellore region
 * Uses precise bounding box to limit results
 */
async function fetchBusStopsFromOverpass() {
  const query = `[out:json][timeout:25];
  (
    node["highway"="bus_stop"](${BOUNDING_BOX.minLat},${BOUNDING_BOX.minLng},${BOUNDING_BOX.maxLat},${BOUNDING_BOX.maxLng});
  );
  out;`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'overpass-api.de',
      port: 443,
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(`data=${encodeURIComponent(query)}`)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          reject(new Error('Failed to parse Overpass API response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(`data=${encodeURIComponent(query)}`);
    req.end();
  });
}

/**
 * Convert raw OSM data to clean bus stop format
 */
function normalizeBusStops(osmData) {
  if (!osmData.elements || !Array.isArray(osmData.elements)) {
    return [];
  }

  return osmData.elements
    .filter(element => element.type === 'node' && element.lat && element.lon)
    .map(element => ({
      id: element.id.toString(),
      name: element.tags?.name || 'Bus Stop',
      lat: element.lat,
      lng: element.lon
    }));
}

/**
 * Get bus stops with caching
 * Returns cached data if available and not expired
 * Otherwise fetches from Overpass API
 */
async function getBusStops() {
  const now = Date.now();

  // Return cached data if valid
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    console.log('[Overpass] Returning cached bus stops');
    return cache.data;
  }

  console.log('[Overpass] Fetching bus stops from API');
  try {
    const osmData = await fetchBusStopsFromOverpass();
    const normalizedStops = normalizeBusStops(osmData);

    // Update cache
    cache.data = normalizedStops;
    cache.timestamp = now;

    console.log(`[Overpass] Fetched ${normalizedStops.length} bus stops`);
    return normalizedStops;
  } catch (error) {
    console.error('[Overpass] Error fetching bus stops:', error.message);

    // Return cached data even if expired as fallback
    if (cache.data) {
      console.log('[Overpass] Using expired cache as fallback');
      return cache.data;
    }

    throw error;
  }
}

/**
 * Clear the cache (for manual refresh)
 */
function clearCache() {
  cache.data = null;
  cache.timestamp = 0;
  console.log('[Overpass] Cache cleared');
}

/**
 * Filter bus stops by bounding box (REQUIRED)
 * Returns limited dataset (200) if bounding box not provided
 */
function filterByBoundingBox(stops, minLat, maxLat, minLng, maxLng) {
  // Fallback: return limited dataset if bounding box not provided
  if (!minLat || !maxLat || !minLng || !maxLng) {
    console.log('[Overpass] Bounding box not provided, returning limited dataset (200)');
    return stops.slice(0, 200);
  }

  const filtered = stops.filter(stop =>
    stop.lat >= minLat &&
    stop.lat <= maxLat &&
    stop.lng >= minLng &&
    stop.lng <= maxLng
  );

  console.log(`[Overpass] Filtered ${stops.length} stops to ${filtered.length} within bounding box`);
  return filtered;
}

/**
 * Limit results to prevent UI overload
 */
function limitResults(stops, limit = MAX_RESULTS) {
  if (stops.length <= limit) {
    return stops;
  }

  console.log(`[Overpass] Limiting results from ${stops.length} to ${limit}`);
  return stops.slice(0, limit);
}

module.exports = {
  getBusStops,
  filterByBoundingBox,
  limitResults,
  clearCache,
  BOUNDING_BOX
};
