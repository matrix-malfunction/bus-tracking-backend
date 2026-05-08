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
  minLat: 12.0,
  maxLat: 13.6,
  minLng: 78.5,
  maxLng: 80.6
};

// Curated bus stops for Vellore and Thiruvallur regions
// These are ALWAYS included regardless of bounding box
const BUS_STOPS = [
  // ===== VELLORE =====
  { id: "bagayam", name: "Bagayam Bus Stop", lat: 12.8801, lng: 79.1348 },
  { id: "sathuvachari_p2", name: "Sathuvachari Bus Stop (Phase 2 / Arcot Rd)", lat: 12.9357, lng: 79.1566 },
  { id: "sathuvachari_tnhb", name: "Sathuvachari Bus Stop (TNHB)", lat: 12.9409, lng: 79.1752 },
  { id: "alamelumangapuram", name: "Alamelumangapuram Bus Stop", lat: 12.9424, lng: 79.1858 },
  { id: "katpadi_main", name: "Katpadi Bus Stand (Main)", lat: 12.9772, lng: 79.1368 },
  { id: "katpadi_chittoor", name: "Katpadi Junction – Chittoor Bus Stand", lat: 12.9663, lng: 79.1375 },
  { id: "katpadi_junction", name: "Katpadi Junction Bus Stop", lat: 12.9711, lng: 79.1372 },
  { id: "katpadi_gudiyatham", name: "Katpadi – Gudiyatham Road", lat: 12.9734, lng: 79.1368 },
  { id: "gudiyatham_cross", name: "Gudiyatham Cross Road", lat: 12.9747, lng: 79.1366 },
  { id: "katpadi_near", name: "Katpadi Near Bus Stand", lat: 12.9800, lng: 79.1367 },
  { id: "gudiyatham_old", name: "Gudiyatham Old Bus Stand", lat: 12.9438, lng: 78.8700 },
  { id: "gudiyatham_depot", name: "Gudiyatham TNSTC Bus Depot", lat: 12.9399, lng: 78.8873 },
  { id: "gandhi_chowk", name: "Gandhi Chowk Bus Stop", lat: 12.9426, lng: 78.8580 },
  { id: "arasamaram", name: "Arasamaram Bus Stop", lat: 12.9526, lng: 78.8721 },
  { id: "polytechnic_cross", name: "Polytechnic Cross Road", lat: 12.9407, lng: 78.8919 },
  { id: "raja_koil", name: "Raja Koil Bus Stop", lat: 12.9530, lng: 78.8933 },
  { id: "gandhi_nagar", name: "Gandhi Nagar Bus Stop", lat: 12.9520, lng: 78.8880 },
  { id: "ranipet_new", name: "Ranipet New Bus Stand", lat: 12.9287, lng: 79.3413 },
  { id: "muthukadai", name: "Muthukadai Bus Stop (Ranipet)", lat: 12.9319, lng: 79.3353 },
  { id: "ranipet_bypass", name: "Ranipet Bypass", lat: 12.9188, lng: 79.3414 },
  { id: "karai_kutroad", name: "Karai Kutroad Bus Stop", lat: 12.9364, lng: 79.3251 },
  { id: "navalpur", name: "Navalpur Bus Stop", lat: 12.9339, lng: 79.3309 },
  { id: "bhel", name: "BHEL Bus Stop (Walajapet Road)", lat: 12.9698, lng: 79.2874 },
  { id: "arcot_busstand", name: "Arcot Bus Stand", lat: 12.9080, lng: 79.3249 },
  { id: "arcot_bypass_vlr", name: "Arcot Bypass (Towards Vellore)", lat: 12.9121, lng: 79.3268 },
  { id: "arcot_bypass_town", name: "Arcot Bypass (Town side)", lat: 12.9123, lng: 79.3224 },
  { id: "periyar_nagar", name: "Periyar Nagar Bus Stop", lat: 12.8922, lng: 79.3193 },
  { id: "thopukkana", name: "Thopukkana Bus Stop", lat: 12.8970, lng: 79.3198 },
  { id: "kannamangalam", name: "Kannamangalam Koot Road Bus Stop", lat: 12.9039, lng: 79.3134 },
  { id: "anna_nagar", name: "Anna Nagar / Masapettai Bus Stop", lat: 12.9045, lng: 79.3070 },
  { id: "walajapet", name: "Walajapet Bus Stand", lat: 12.9258, lng: 79.3645 },
  { id: "ambur", name: "Ambur Bus Stand", lat: 12.7825, lng: 78.7192 },
  { id: "vaniyambadi", name: "Vaniyambadi Bus Stand", lat: 12.6782, lng: 78.6204 },
  { id: "vaniyambadi_bypass", name: "Vaniyambadi Bypass Bus Stop", lat: 12.6767, lng: 78.6222 },
  { id: "sholinghur_new", name: "Sholinghur Bus Stand (New)", lat: 13.1110, lng: 79.4203 },
  { id: "sholinghur_depot", name: "Sholinghur Bus Depot", lat: 13.0997, lng: 79.4185 },
  // ===== THIRUVALLUR =====
  { id: "poonamallee", name: "Poonamallee Bus Stand", lat: 13.0517, lng: 80.0948 },
  { id: "poonamallee_bypass", name: "Poonamallee Bypass", lat: 13.0504, lng: 80.0890 },
  { id: "poonamallee_depot", name: "Poonamallee Bypass (Near Depot)", lat: 13.0520, lng: 80.0907 },
  { id: "kumananchavadi", name: "Kumananchavadi", lat: 13.0451, lng: 80.1160 },
  { id: "bsnl_poonamallee", name: "BSNL Exchange Bus Stop", lat: 13.0513, lng: 80.0897 },
  { id: "avadi", name: "Avadi Bus Stand", lat: 13.1202, lng: 80.1021 },
  { id: "avadi_checkpost", name: "Avadi Check Post", lat: 13.1193, lng: 80.0942 },
  { id: "avadi_market", name: "Avadi Market Bus Stop", lat: 13.1159, lng: 80.1053 },
  { id: "avadi_hvf", name: "Avadi (HVF Road)", lat: 13.1205, lng: 80.1032 },
  { id: "tiruttani_old", name: "Tiruttani Old Bus Stand", lat: 13.1745, lng: 79.6132 },
  { id: "tiruttani_new", name: "Tiruttani New Bus Stand", lat: 13.1650, lng: 79.6159 },
  { id: "tiruttani_bypass", name: "Tiruttani Bypass", lat: 13.1843, lng: 79.6107 },
  { id: "thanigai", name: "Thanigai Devasthanam Bus Stop", lat: 13.1707, lng: 79.6033 },
  { id: "redhills_terminal", name: "Red Hills Bus Terminal", lat: 13.1929, lng: 80.1842 },
  { id: "redhills_town", name: "Red Hills Town Centre", lat: 13.1928, lng: 80.1838 },
  { id: "redhills_market", name: "Red Hills Market Bus Stop", lat: 13.1895, lng: 80.1874 },
  { id: "redhills_junction", name: "Red Hills Junction", lat: 13.1966, lng: 80.1810 },
  { id: "gummidipoondi", name: "Gummidipoondi Bus Stop", lat: 13.4084, lng: 80.1268 },
  { id: "rettempedu", name: "Rettempedu Road Junction", lat: 13.4128, lng: 80.1270 }
];

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
 * Otherwise fetches from Overpass API and merges with curated stops
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
    const overpassStops = normalizeBusStops(osmData);
    
    console.log(`[Overpass] Raw Overpass results: ${overpassStops.length}`);
    console.log(`[Overpass] Curated BUS_STOPS: ${BUS_STOPS.length}`);

    // Merge Overpass + Curated (curated stops are ALWAYS included)
    const mergedStops = [...overpassStops, ...BUS_STOPS];
    
    console.log(`[Overpass] Final merged count: ${mergedStops.length}`);

    // Update cache
    cache.data = mergedStops;
    cache.timestamp = now;

    return mergedStops;
  } catch (error) {
    console.error('[Overpass] Error fetching bus stops:', error.message);

    // Return cached data even if expired as fallback
    if (cache.data) {
      console.log('[Overpass] Using expired cache as fallback');
      return cache.data;
    }

    // Return curated stops as emergency fallback
    console.log('[Overpass] Using BUS_STOPS as emergency fallback');
    return BUS_STOPS;
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
