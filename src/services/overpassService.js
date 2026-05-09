/**
 * Overpass API Service for fetching bus stops from OpenStreetMap
 * Caches results for 24 hours to reduce API calls
 */

const https = require('https');

// Try to use axios if available for more reliable HTTP requests
let axios;
try {
  axios = require('axios');
} catch (e) {
  axios = null;
}

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
  { id: "rettempedu", name: "Rettempedu Road Junction", lat: 13.4128, lng: 80.1270 },

  // ===== CUSTOM VELLORE + THIRUVALLUR STOPS =====

  { id: "custom_vlr_001", name: "Bagayam Bus Stop", lat: 12.8801, lng: 79.1348 },
  { id: "custom_vlr_002", name: "Sathuvachari Bus Stop (Phase 2 / Arcot Rd)", lat: 12.9357, lng: 79.1566 },
  { id: "custom_vlr_003", name: "Sathuvachari Bus Stop (TNHB)", lat: 12.9409, lng: 79.1752 },
  { id: "custom_vlr_004", name: "Alamelumangapuram Bus Stop", lat: 12.9424, lng: 79.1858 },
  { id: "custom_vlr_005", name: "Katpadi Bus Stand (Main / NH75 side)", lat: 12.9772, lng: 79.1368 },
  { id: "custom_vlr_006", name: "Katpadi Junction – Chittoor Bus Stand", lat: 12.9663, lng: 79.1375 },
  { id: "custom_vlr_007", name: "Katpadi Junction Bus Stop (VLR KPD)", lat: 12.9711, lng: 79.1372 },
  { id: "custom_vlr_008", name: "Katpadi – Gudiyatham Road Bus Stand", lat: 12.9734, lng: 79.1368 },
  { id: "custom_vlr_009", name: "Gudiyatham Cross Road Public Bus Stop", lat: 12.9747, lng: 79.1366 },
  { id: "custom_vlr_010", name: "Katpadi – Near Bus Stand", lat: 12.9800, lng: 79.1367 },
  { id: "custom_vlr_011", name: "Gudiyatham Old Bus Stand", lat: 12.9438, lng: 78.8700 },
  { id: "custom_vlr_012", name: "Gudiyatham TNSTC Bus Depot", lat: 12.9399, lng: 78.8873 },
  { id: "custom_vlr_013", name: "Gandhi Chowk Bus Stop", lat: 12.9426, lng: 78.8580 },
  { id: "custom_vlr_014", name: "Arasamaram Bus Stop", lat: 12.9526, lng: 78.8721 },
  { id: "custom_vlr_015", name: "Polytechnic Cross Road Bus Stop", lat: 12.9407, lng: 78.8919 },
  { id: "custom_vlr_016", name: "Raja Koil Bus Stop", lat: 12.9530, lng: 78.8933 },
  { id: "custom_vlr_017", name: "Gandhi Nagar Bus Stop", lat: 12.9520, lng: 78.8880 },
  { id: "custom_vlr_018", name: "Ranipet New Bus Stand", lat: 12.9287, lng: 79.3413 },
  { id: "custom_vlr_019", name: "Muthukadai Bus Stop (Ranipet)", lat: 12.9319, lng: 79.3353 },
  { id: "custom_vlr_020", name: "Ranipet Bypass", lat: 12.9188, lng: 79.3414 },
  { id: "custom_vlr_021", name: "Karai Kutroad Bus Stop", lat: 12.9364, lng: 79.3251 },
  { id: "custom_vlr_022", name: "Navalpur Bus Stop", lat: 12.9339, lng: 79.3309 },
  { id: "custom_vlr_023", name: "BHEL Bus Stop (Walajapet Road)", lat: 12.9698, lng: 79.2874 },
  { id: "custom_vlr_024", name: "Arcot Bus Stand", lat: 12.9080, lng: 79.3249 },
  { id: "custom_vlr_025", name: "Arcot Bypass Bus Stop (Towards Vellore)", lat: 12.9121, lng: 79.3268 },
  { id: "custom_vlr_026", name: "Arcot Bypass (Town side)", lat: 12.9123, lng: 79.3224 },
  { id: "custom_vlr_027", name: "Periyar Nagar Bus Stop", lat: 12.8922, lng: 79.3193 },
  { id: "custom_vlr_028", name: "Thopukkana Bus Stop", lat: 12.8970, lng: 79.3198 },
  { id: "custom_vlr_029", name: "Kannamangalam Koot Road Bus Stop", lat: 12.9039, lng: 79.3134 },
  { id: "custom_vlr_030", name: "Anna Nagar / Masapettai Bus Stop", lat: 12.9045, lng: 79.3070 },
  { id: "custom_vlr_031", name: "Walajapet Bus Stand", lat: 12.9258, lng: 79.3645 },
  { id: "custom_vlr_032", name: "Ambur Bus Stand", lat: 12.7825, lng: 78.7192 },
  { id: "custom_vlr_033", name: "Vaniyambadi Bus Stand", lat: 12.6782, lng: 78.6204 },
  { id: "custom_vlr_034", name: "Vaniyambadi Bypass Bus Stop", lat: 12.6767, lng: 78.6222 },
  { id: "custom_vlr_035", name: "Sholinghur Bus Stand (New)", lat: 13.1110, lng: 79.4203 },
  { id: "custom_vlr_036", name: "Sholinghur Bus Depot", lat: 13.0997, lng: 79.4185 },

  // Thiruvallur
  { id: "custom_tvl_001", name: "Poonamallee Bus Stand", lat: 13.0517, lng: 80.0948 },
  { id: "custom_tvl_002", name: "Poonamallee Bypass", lat: 13.0504, lng: 80.0890 },
  { id: "custom_tvl_003", name: "Poonamallee Bypass (Near Bus Depot)", lat: 13.0520, lng: 80.0907 },
  { id: "custom_tvl_004", name: "Poonamallee Municipality / Kumananchavadi", lat: 13.0451, lng: 80.1160 },
  { id: "custom_tvl_005", name: "BSNL Exchange Bus Stop (Poonamallee)", lat: 13.0513, lng: 80.0897 },
  { id: "custom_tvl_006", name: "Avadi Bus Stand", lat: 13.1202, lng: 80.1021 },
  { id: "custom_tvl_007", name: "Avadi Check Post", lat: 13.1193, lng: 80.0942 },
  { id: "custom_tvl_008", name: "Avadi Market Bus Stop", lat: 13.1159, lng: 80.1053 },
  { id: "custom_tvl_009", name: "Avadi (HVF Road)", lat: 13.1205, lng: 80.1032 },
  { id: "custom_tvl_010", name: "Tiruttani Anna Bus Stand (Old)", lat: 13.1745, lng: 79.6132 },
  { id: "custom_tvl_011", name: "Tiruttani New Bus Stand", lat: 13.1650, lng: 79.6159 },
  { id: "custom_tvl_012", name: "Tiruttani Bypass Bus Stop", lat: 13.1843, lng: 79.6107 },
  { id: "custom_tvl_013", name: "Thanigai Devasthanam Bus Stop", lat: 13.1707, lng: 79.6033 },
  { id: "custom_tvl_014", name: "Red Hills Bus Terminal", lat: 13.1929, lng: 80.1842 },
  { id: "custom_tvl_015", name: "Red Hills (Town Centre)", lat: 13.1928, lng: 80.1838 },
  { id: "custom_tvl_016", name: "Red Hills Market Bus Stop", lat: 13.1895, lng: 80.1874 },
  { id: "custom_tvl_017", name: "Red Hills – Thiruvallur Road Junction", lat: 13.1966, lng: 80.1810 },
  { id: "custom_tvl_018", name: "Gummidipoondi Bus Stop", lat: 13.4084, lng: 80.1268 },
  { id: "custom_tvl_019", name: "Rettempedu Road Junction", lat: 13.4128, lng: 80.1270 },

  // ===== CONTINUOUS CUSTOM EXTENSION =====

  { id: "custom_stop_111", name: "Kangeyanallur Bus Stop", lat: 12.9532, lng: 79.1524 },
  { id: "custom_stop_112", name: "Anaicut New Bus Stand", lat: 12.8762, lng: 78.9882 },
  { id: "custom_stop_113", name: "Raja Theatre Bus Stop", lat: 12.9148, lng: 79.1324 },
  { id: "custom_stop_114", name: "Thottapalayam Area Bus Stop", lat: 12.9288, lng: 79.1340 },
  { id: "custom_stop_115", name: "Staff Bus Stop (IDA Scudder Rd)", lat: 12.9251, lng: 79.1369 },
  { id: "custom_stop_116", name: "CMC Bus Stop", lat: 12.9245, lng: 79.1333 },
  { id: "custom_stop_117", name: "Vellore Mofussil Bus Terminus", lat: 12.9346, lng: 79.1384 },
  { id: "custom_stop_118", name: "Tirupattur Bus Stand", lat: 12.4962, lng: 78.5695 },
  { id: "custom_stop_119", name: "Tirupattur Old Bus Stand", lat: 12.4973, lng: 78.5686 },
  { id: "custom_stop_120", name: "Tirupattur Pudupattai Road", lat: 12.4897, lng: 78.5647 },
  { id: "custom_stop_121", name: "Pernambut Bus Stand", lat: 12.9392, lng: 78.7190 },

  { id: "custom_stop_122", name: "Ennore Bus Terminal", lat: 13.2148, lng: 80.3208 },
  { id: "custom_stop_123", name: "Ernavoor Bus Stop", lat: 13.1909, lng: 80.3106 },
  { id: "custom_stop_124", name: "Ponneri Main", lat: 13.3292, lng: 80.1876 },
  { id: "custom_stop_125", name: "Ponneri Market", lat: 13.3353, lng: 80.1903 },
  { id: "custom_stop_126", name: "Ponneri Taluk Office", lat: 13.3319, lng: 80.1945 },
  { id: "custom_stop_127", name: "Thiruvayarpadi Bus Stop", lat: 13.3390, lng: 80.1944 },
  { id: "custom_stop_128", name: "Krishnapuram Bus Stand", lat: 13.3198, lng: 80.1825 },
  { id: "custom_stop_129", name: "Minjur Bus Stand", lat: 13.2821, lng: 80.2538 },
  { id: "custom_stop_130", name: "Minjur Market", lat: 13.2790, lng: 80.2601 },
  { id: "custom_stop_131", name: "Minjur New Bus Stop", lat: 13.2825, lng: 80.2539 },
  { id: "custom_stop_132", name: "Minjur BDO Office", lat: 13.2677, lng: 80.2647 },

  
  { id: "custom_stop_134", name: "Vellore Men's Jail", lat: 12.8881, lng: 79.1221 },
  { id: "custom_stop_135", name: "Women's Prison", lat: 12.8838, lng: 79.1232 },
  { id: "custom_stop_136", name: "Golden Temple Gate", lat: 12.8699, lng: 79.0882 },
  { id: "custom_stop_137", name: "Vellore Fort Terminus", lat: 12.9221, lng: 79.1322 },
  { id: "custom_stop_138", name: "Infantry Road Stop", lat: 12.9113, lng: 79.1305 },
  { id: "custom_stop_139", name: "Kagithapatarai Bypass", lat: 12.9338, lng: 79.1436 },
  { id: "custom_stop_140", name: "Vellore Cantonment Station", lat: 12.9107, lng: 79.1276 },
  { id: "custom_stop_141", name: "Thottapalayam Bypass", lat: 12.9328, lng: 79.1369 },
  { id: "custom_stop_142", name: "Thangal VIT Area", lat: 12.9659, lng: 79.1663 },
  { id: "custom_stop_143", name: "Ponnai Bus Stop", lat: 13.1269, lng: 79.2553 },
  { id: "custom_stop_144", name: "Vellore Fort Main Gate", lat: 12.9220, lng: 79.1320 },
  { id: "custom_stop_145", name: "Kosapet Stop", lat: 12.9113, lng: 79.1305 },
  { id: "custom_stop_146", name: "Samuel Nagar Bypass", lat: 12.9340, lng: 79.1436 },

  // ===== THIRUVALLUR EXTENSION (APPEND ONLY) =====

  { id: "custom_tvl_ext_001", name: "Thiruvallur Bus Stand", lat: 13.1386, lng: 79.9076 },
  { id: "custom_tvl_ext_002", name: "Thiruvallur Terminal", lat: 13.1405, lng: 79.9080 },
  { id: "custom_tvl_ext_003", name: "Thiruvallur Oil Mill Bus Stop", lat: 13.1227, lng: 79.9118 },
  { id: "custom_tvl_ext_004", name: "Theradi Bus Stop", lat: 13.1433, lng: 79.9088 },
  { id: "custom_tvl_ext_005", name: "Thiruvallur Court Bus Stop", lat: 13.1370, lng: 79.9176 },

  // Same coordinate but different logical stop
  { id: "custom_tvl_ext_006", name: "Thiruvallur Bustand (Kakkalur)", lat: 13.1227, lng: 79.9118 },

  // These may already exist → still add as new custom IDs
  { id: "custom_tvl_ext_007", name: "Manavalanagar Bus Stop", lat: 13.1126, lng: 79.9133 },
  { id: "custom_tvl_ext_008", name: "Ondikuppam Bus Stop", lat: 13.1104, lng: 79.9180 },

  { id: "custom_tvl_ext_009", name: "SBI Bus Stop (JN Road)", lat: 13.1354, lng: 79.9087 },

  // Already exists earlier → still safe due to new ID
  { id: "custom_tvl_ext_010", name: "Poonamallee Bus Stand", lat: 13.0517, lng: 80.0948 }
];

// Production-safe: Ensure arrays exist before spreading
const ALL_STOPS = [
  ...(Array.isArray(BUS_STOPS) ? BUS_STOPS : []),
  ...(Array.isArray(CUSTOM_STOPS) ? CUSTOM_STOPS : [])
];

// Production-safe stop name lookup map with normalized string IDs
const STOP_NAME_MAP = new Map(
  ALL_STOPS.map(stop => [String(stop.id), stop.name])
);

// Get stop name by ID with safe normalization
function getStopNameById(stopId) {
  if (!stopId) return null;
  return STOP_NAME_MAP.get(String(stopId)) || null;
}

/**
 * Fetch bus stops from Overpass API for Thiruvallur and Vellore region
 * Uses precise bounding box to limit results
 */
async function fetchBusStopsFromOverpass() {
  // Use static bbox as requested: 12.0,78.0,13.5,80.5
  const query = `[out:json][timeout:60];
(
  node["highway"="bus_stop"](12.0,78.0,13.5,80.5);
);
out body;`;
  console.log('[Overpass] Query with static bbox: 12.0,78.0,13.5,80.5');

  // Try axios first if available (more reliable)
  if (axios) {
    try {
      console.log('[Overpass] Using axios for request');
      const response = await axios.post(
        'https://overpass-api.de/api/interpreter',
        `data=${encodeURIComponent(query)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          },
          timeout: 65000
        }
      );
      const elements = response.data?.elements || [];
      console.log(`[Overpass] Axios response: ${response.status}, elements: ${elements.length}`);
      if (elements.length === 0) {
        console.warn('[Overpass] WARNING: Empty elements array from Overpass');
      }
      return response.data;
    } catch (axiosError) {
      console.error('[Overpass] Axios request failed:', axiosError.message);
      console.log('[Overpass] Falling back to native https');
    }
  }

  // Fallback to native https
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'overpass-api.de',
      port: 443,
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(`data=${encodeURIComponent(query)}`),
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      console.log(`[Overpass] HTTPS response status: ${res.statusCode}`);

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const elements = json.elements || [];
          console.log(`[Overpass] HTTPS returned ${elements.length} elements`);
          if (elements.length === 0) {
            console.warn('[Overpass] WARNING: Empty elements from Overpass HTTPS');
            console.warn('[Overpass] Response keys:', Object.keys(json));
          }
          resolve(json);
        } catch (error) {
          console.error('[Overpass] Failed to parse HTTPS response:', error.message);
          console.error('[Overpass] Raw response preview:', data.substring(0, 200));
          reject(new Error('Failed to parse Overpass API response'));
        }
      });
    });

    req.on('error', (error) => {
      console.error('[Overpass] HTTPS request error:', error.message);
      reject(error);
    });

    req.setTimeout(65000, () => {
      console.error('[Overpass] HTTPS request timeout');
      req.destroy();
      reject(new Error('Overpass API timeout'));
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
    console.warn('[Overpass] normalizeBusStops: Missing or invalid elements array');
    console.warn('[Overpass] osmData keys:', Object.keys(osmData));
    return [];
  }

  const stops = osmData.elements
    .filter(element => element.type === 'node' && element.lat && element.lon)
    .map(element => ({
      id: element.id.toString(),
      name: element.tags?.name || 'Bus Stop',
      lat: element.lat,
      lng: element.lon
    }));
  
  console.log(`[Overpass] normalizeBusStops: ${stops.length} stops from ${osmData.elements.length} elements`);
  return stops;
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

    // Always try to return cached data if available (contains merged overpass + BUS_STOPS)
    if (cache.data) {
      console.log('[Overpass] Using cached merged data as fallback');
      const expiredStops = cache.data;
      const overpassCount = expiredStops.filter(s => s.id && /^\d+$/.test(s.id)).length;
      const customCount = expiredStops.filter(s => s.id && s.id.startsWith('custom_')).length;
      console.log(`[Overpass] Cache has ${overpassCount} overpass + ${customCount} custom stops`);
      return expiredStops;
    }

    // No cache - we cannot get overpass stops
    // Log critical error but still return BUS_STOPS so app doesn't break completely
    console.error('[Overpass] CRITICAL: No cache and Overpass failed');
    console.error('[Overpass] Returning BUS_STOPS only - original stops MISSING');
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

// Export all stops and lookup function
module.exports = {
  getBusStops,
  filterByBoundingBox,
  limitResults,
  clearCache,
  BOUNDING_BOX,
  BUS_STOPS,
  CUSTOM_STOPS,
  ALL_STOPS,
  getStopNameById
};
