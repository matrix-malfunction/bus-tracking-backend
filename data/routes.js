// Stop name mapping for stop ID to name resolution
const STOP_NAMES = {
  "custom_stop_117": "Vellore Mofussil Bus Terminus",
  "custom_stop_144": "Vellore Fort Main Gate",
  "custom_stop_137": "Vellore Fort Terminus",
  "custom_stop_113": "Raja Theatre Bus Stop",
  "custom_stop_116": "CMC Bus Stop",
  "custom_stop_115": "Staff Bus Stop (IDA Scudder Rd)",
  "custom_stop_138": "Infantry Road Stop",
  "custom_stop_140": "Vellore Cantonment Station",
  "custom_stop_114": "Thottapalayam Area Bus Stop",
  "custom_stop_141": "Thottapalayam Bypass",
  "custom_stop_139": "Kagithapatarai Bypass",
  "sathuvachari_p2": "Sathuvachari Bus Stop (Phase 2)",
  "custom_stop_111": "Kangeyanallur Bus Stop",
  "custom_stop_142": "Thangal VIT Area",
  "katpadi_junction": "Katpadi Junction Bus Stop",
  "katpadi_main": "Katpadi Bus Stand (Main)",
  "arcot_bypass_vlr": "Arcot Bypass (Towards Vellore)",
  "arcot_bypass_town": "Arcot Bypass (Town side)",
  "arcot_busstand": "Arcot Bus Stand",
  "periyar_nagar": "Periyar Nagar Bus Stop",
  "thopukkana": "Thopukkana Bus Stop",
  "kannamangalam": "Kannamangalam Koot Road Bus Stop",
  "anna_nagar": "Anna Nagar Bus Stop",
  "navalpur": "Navalpur Bus Stop",
  "karai_kutroad": "Karai Kutroad Bus Stop",
  "muthukadai": "Muthukadai Bus Stop (Ranipet)",
  "ranipet_new": "Ranipet New Bus Stand",
  "ranipet_bypass": "Ranipet Bypass",
  "walajapet": "Walajapet Bus Stand",
  "custom_stop_121": "Pernambut Bus Stand",
  "vaniyambadi_bypass": "Vaniyambadi Bypass Bus Stop",
  "vaniyambadi": "Vaniyambadi Bus Stand",
  "ambur": "Ambur Bus Stand",
  "custom_stop_143": "Ponnai Bus Stop",
  "sholinghur_depot": "Sholinghur Bus Depot",
  "sholinghur_new": "Sholinghur Bus Stand (New)",
  "bagayam": "Bagayam Bus Stop",
  "sathuvachari_tnhb": "Sathuvachari Bus Stop (TNHB)",
  "alamelumangapuram": "Alamelumangapuram Bus Stop",
  "custom_stop_112": "Anaicut New Bus Stand",
  "custom_stop_120": "Tirupattur Pudupattai Road",
  "custom_stop_119": "Tirupattur Old Bus Stand",
  "custom_stop_118": "Tirupattur Bus Stand",
  "custom_stop_135": "Women's Prison",
  "custom_stop_134": "Vellore Men's Jail",
  "custom_stop_136": "Golden Temple Gate",
  "katpadi_chittoor": "Katpadi Junction – Chittoor Bus Stand",
  "bhel": "BHEL Bus Stop (Walajapet Road)",
  "custom_tvl_ext_001": "Thiruvallur Bus Stand",
  "custom_tvl_ext_002": "Thiruvallur Terminal",
  "custom_tvl_ext_004": "Theradi Bus Stop",
  "custom_tvl_ext_005": "Thiruvallur Court Bus Stop",
  "custom_tvl_ext_009": "SBI Bus Stop (JN Road)",
  "custom_tvl_004": "Poonamallee Municipality / Kumananchavadi",
  "custom_tvl_003": "Poonamallee Bypass (Near Bus Depot)",
  "custom_tvl_002": "Poonamallee Bypass",
  "custom_tvl_001": "Poonamallee Bus Stand",
  "custom_tvl_005": "BSNL Exchange Bus Stop (Poonamallee)",
  "custom_tvl_007": "Avadi Check Post",
  "custom_tvl_008": "Avadi Market Bus Stop",
  "custom_tvl_006": "Avadi Bus Stand"
};

module.exports = {
  routes: [

  // ─────────────────────────────────────────────
  // VELLORE DISTRICT ROUTES (most common first)
  // ─────────────────────────────────────────────

  {
    id: "VLR_1",
    name: "Vellore Central Loop",
    shortName: "VLR-CL",
    color: "#2563eb",
    district: "Vellore",
    type: "city",
    stops: [
      "custom_stop_117",   // Vellore Mofussil Bus Terminus
      "custom_stop_144",   // Vellore Fort Main Gate
      "custom_stop_137",   // Vellore Fort Terminus
      "custom_stop_113",   // Raja Theatre Bus Stop
      "custom_stop_116",   // CMC Bus Stop
      "custom_stop_115",   // Staff Bus Stop (IDA Scudder Rd)
      "custom_stop_138",   // Infantry Road Stop
      "custom_stop_140",   // Vellore Cantonment Station
      "custom_stop_114",   // Thottapalayam Area Bus Stop
      "custom_stop_141",   // Thottapalayam Bypass
      "custom_stop_117"    // Vellore Mofussil Bus Terminus (loop end)
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9220, 79.1320],
      [12.9221, 79.1322],
      [12.9148, 79.1324],
      [12.9245, 79.1333],
      [12.9251, 79.1369],
      [12.9113, 79.1305],
      [12.9107, 79.1276],
      [12.9288, 79.1340],
      [12.9328, 79.1369],
      [12.9346, 79.1384]
    ]
  },

  {
    id: "VLR_2",
    name: "Vellore – Katpadi Express",
    shortName: "VLR-KPD",
    color: "#dc2626",
    district: "Vellore",
    type: "express",
    stops: [
      "custom_stop_117",   // Vellore Mofussil Bus Terminus
      "custom_stop_141",   // Thottapalayam Bypass
      "custom_stop_139",   // Kagithapatarai Bypass
      "sathuvachari_p2",   // Sathuvachari Bus Stop (Phase 2 / Arcot Rd)
      "custom_stop_111",   // Kangeyanallur Bus Stop
      "custom_stop_142",   // Thangal VIT Area
      "katpadi_junction",  // Katpadi Junction Bus Stop
      "katpadi_main"       // Katpadi Bus Stand (Main)
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9328, 79.1369],
      [12.9338, 79.1436],
      [12.9357, 79.1566],
      [12.9532, 79.1524],
      [12.9659, 79.1663],
      [12.9711, 79.1372],
      [12.9772, 79.1368]
    ]
  },

  {
    id: "VLR_3",
    name: "Vellore – Ranipet – Walajapet",
    shortName: "VLR-RNP",
    color: "#16a34a",
    district: "Vellore",
    type: "mofussil",
    stops: [
      "custom_stop_117",      // Vellore Mofussil Bus Terminus
      "custom_stop_139",      // Kagithapatarai Bypass
      "arcot_bypass_vlr",     // Arcot Bypass (Towards Vellore)
      "arcot_bypass_town",    // Arcot Bypass (Town side)
      "arcot_busstand",       // Arcot Bus Stand
      "periyar_nagar",        // Periyar Nagar Bus Stop
      "thopukkana",           // Thopukkana Bus Stop
      "kannamangalam",        // Kannamangalam Koot Road Bus Stop
      "anna_nagar",           // Anna Nagar / Masapettai Bus Stop
      "navalpur",             // Navalpur Bus Stop
      "karai_kutroad",        // Karai Kutroad Bus Stop
      "muthukadai",           // Muthukadai Bus Stop (Ranipet)
      "ranipet_new",          // Ranipet New Bus Stand
      "ranipet_bypass",       // Ranipet Bypass
      "walajapet"             // Walajapet Bus Stand
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9338, 79.1436],
      [12.9121, 79.3268],
      [12.9123, 79.3224],
      [12.9080, 79.3249],
      [12.8922, 79.3193],
      [12.8970, 79.3198],
      [12.9039, 79.3134],
      [12.9045, 79.3070],
      [12.9339, 79.3309],
      [12.9364, 79.3251],
      [12.9319, 79.3353],
      [12.9287, 79.3413],
      [12.9188, 79.3414],
      [12.9258, 79.3645]
    ]
  },

  {
    id: "VLR_4",
    name: "Vellore – Gudiyatham",
    shortName: "VLR-GDY",
    color: "#d97706",
    district: "Vellore",
    type: "mofussil",
    stops: [
      "custom_stop_117",    // Vellore Mofussil Bus Terminus
      "katpadi_junction",   // Katpadi Junction Bus Stop
      "katpadi_main",       // Katpadi Bus Stand (Main)
      "katpadi_gudiyatham", // Katpadi – Gudiyatham Road
      "gudiyatham_cross",   // Gudiyatham Cross Road
      "katpadi_near",       // Katpadi Near Bus Stand
      "arasamaram",         // Arasamaram Bus Stop
      "gandhi_nagar",       // Gandhi Nagar Bus Stop
      "polytechnic_cross",  // Polytechnic Cross Road
      "raja_koil",          // Raja Koil Bus Stop
      "gandhi_chowk",       // Gandhi Chowk Bus Stop
      "gudiyatham_depot",   // Gudiyatham TNSTC Bus Depot
      "gudiyatham_old"      // Gudiyatham Old Bus Stand
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9711, 79.1372],
      [12.9772, 79.1368],
      [12.9734, 79.1368],
      [12.9747, 79.1366],
      [12.9800, 79.1367],
      [12.9526, 78.8721],
      [12.9520, 78.8880],
      [12.9407, 78.8919],
      [12.9530, 78.8933],
      [12.9426, 78.8580],
      [12.9399, 78.8873],
      [12.9438, 78.8700]
    ]
  },

  {
    id: "VLR_5",
    name: "Vellore – Vaniyambadi – Ambur",
    shortName: "VLR-VNB",
    color: "#7c3aed",
    district: "Vellore",
    type: "mofussil",
    stops: [
      "custom_stop_117",    // Vellore Mofussil Bus Terminus
      "custom_stop_121",    // Pernambut Bus Stand
      "vaniyambadi_bypass", // Vaniyambadi Bypass Bus Stop
      "vaniyambadi",        // Vaniyambadi Bus Stand
      "ambur"               // Ambur Bus Stand
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9392, 78.7190],
      [12.6767, 78.6222],
      [12.6782, 78.6204],
      [12.7825, 78.7192]
    ]
  },

  {
    id: "VLR_6",
    name: "Vellore – Sholinghur",
    shortName: "VLR-SHR",
    color: "#0891b2",
    district: "Vellore",
    type: "mofussil",
    stops: [
      "custom_stop_117",  // Vellore Mofussil Bus Terminus
      "custom_stop_143",  // Ponnai Bus Stop
      "sholinghur_depot", // Sholinghur Bus Depot
      "sholinghur_new"    // Sholinghur Bus Stand (New)
    ],
    coordinates: [
      [12.9346, 79.1384],
      [13.1269, 79.2553],
      [13.0997, 79.4185],
      [13.1110, 79.4203]
    ]
  },

  {
    id: "VLR_7",
    name: "Vellore City – Bagayam – Sathuvachari",
    shortName: "VLR-BGM",
    color: "#be185d",
    district: "Vellore",
    type: "city",
    stops: [
      "custom_stop_117",   // Vellore Mofussil Bus Terminus
      "custom_stop_137",   // Vellore Fort Terminus
      "custom_stop_140",   // Vellore Cantonment Station
      "bagayam",           // Bagayam Bus Stop
      "sathuvachari_p2",   // Sathuvachari Bus Stop (Phase 2 / Arcot Rd)
      "sathuvachari_tnhb", // Sathuvachari Bus Stop (TNHB)
      "alamelumangapuram"  // Alamelumangapuram Bus Stop
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9221, 79.1322],
      [12.9107, 79.1276],
      [12.8801, 79.1348],
      [12.9357, 79.1566],
      [12.9409, 79.1752],
      [12.9424, 79.1858]
    ]
  },

  {
    id: "VLR_8",
    name: "Vellore – Anaicut – Tirupattur",
    shortName: "VLR-TPT",
    color: "#065f46",
    district: "Vellore",
    type: "mofussil",
    stops: [
      "custom_stop_117",  // Vellore Mofussil Bus Terminus
      "custom_stop_112",  // Anaicut New Bus Stand
      "custom_stop_120",  // Tirupattur Pudupattai Road
      "custom_stop_119",  // Tirupattur Old Bus Stand
      "custom_stop_118"   // Tirupattur Bus Stand
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.8762, 78.9882],
      [12.4897, 78.5647],
      [12.4973, 78.5686],
      [12.4962, 78.5695]
    ]
  },

  {
    id: "VLR_9",
    name: "Vellore – Golden Temple – Thirumalaikodi",
    shortName: "VLR-GT",
    color: "#b45309",
    district: "Vellore",
    type: "city",
    stops: [
      "custom_stop_117",  // Vellore Mofussil Bus Terminus
      "custom_stop_137",  // Vellore Fort Terminus
      "custom_stop_140",  // Vellore Cantonment Station
      "custom_stop_135",  // Women's Prison
      "custom_stop_134",  // Vellore Men's Jail
      "custom_stop_136"   // Golden Temple Gate
    ],
    coordinates: [
      [12.9346, 79.1384],
      [12.9221, 79.1322],
      [12.9107, 79.1276],
      [12.8838, 79.1232],
      [12.8881, 79.1221],
      [12.8699, 79.0882]
    ]
  },

  {
    id: "VLR_10",
    name: "Katpadi – BHEL – Ranipet",
    shortName: "KPD-BHEL",
    color: "#6d28d9",
    district: "Vellore",
    type: "express",
    stops: [
      "katpadi_main",      // Katpadi Bus Stand (Main)
      "katpadi_chittoor",  // Katpadi Junction – Chittoor Bus Stand
      "katpadi_junction",  // Katpadi Junction Bus Stop
      "bhel",              // BHEL Bus Stop (Walajapet Road)
      "ranipet_new"        // Ranipet New Bus Stand
    ],
    coordinates: [
      [12.9772, 79.1368],
      [12.9663, 79.1375],
      [12.9711, 79.1372],
      [12.9698, 79.2874],
      [12.9287, 79.3413]
    ]
  },

  {
    id: "VLR_11",
    name: "Katpadi Railway Station – Bagayam (& Return)",
    shortName: "KPD-BGM",
    color: "#e11d48",
    district: "Vellore",
    type: "city",
    direction: "both",
    stops: [
      "katpadi_main",      // Katpadi Bus Stand (Main)
      "katpadi_junction",  // Katpadi Junction Bus Stop
      "katpadi_chittoor",  // Katpadi Junction – Chittoor Bus Stand
      "custom_stop_142",   // Thangal VIT Area
      "sathuvachari_tnhb", // Sathuvachari Bus Stop (TNHB)
      "sathuvachari_p2",   // Sathuvachari Bus Stop (Phase 2 / Arcot Rd)
      "custom_stop_139",   // Kagithapatarai Bypass
      "custom_stop_117",   // Vellore Mofussil Bus Terminus
      "custom_stop_116",   // CMC Bus Stop
      "custom_stop_140",   // Vellore Cantonment Station
      "bagayam"            // Bagayam Bus Stop
    ],
    returnStops: [
      "bagayam",           // Bagayam Bus Stop
      "custom_stop_140",   // Vellore Cantonment Station
      "custom_stop_116",   // CMC Bus Stop
      "custom_stop_117",   // Vellore Mofussil Bus Terminus
      "custom_stop_139",   // Kagithapatarai Bypass
      "sathuvachari_p2",   // Sathuvachari Bus Stop (Phase 2 / Arcot Rd)
      "sathuvachari_tnhb", // Sathuvachari Bus Stop (TNHB)
      "custom_stop_142",   // Thangal VIT Area
      "katpadi_chittoor",  // Katpadi Junction – Chittoor Bus Stand
      "katpadi_junction",  // Katpadi Junction Bus Stop
      "katpadi_main"       // Katpadi Bus Stand (Main)
    ],
    coordinates: [
      [12.9772, 79.1368],
      [12.9711, 79.1372],
      [12.9663, 79.1375],
      [12.9659, 79.1663],
      [12.9409, 79.1752],
      [12.9357, 79.1566],
      [12.9338, 79.1436],
      [12.9346, 79.1384],
      [12.9245, 79.1333],
      [12.9107, 79.1276],
      [12.8801, 79.1348]
    ]
  },

  // ─────────────────────────────────────────────
  // THIRUVALLUR DISTRICT — ONE NORMAL ROUTE
  // ─────────────────────────────────────────────

  {
    id: "TRL_1",
    name: "Thiruvallur – Poonamallee – Avadi",
    shortName: "TRL-AVD",
    color: "#0f766e",
    district: "Thiruvallur",
    type: "mofussil",
    stops: [
      "custom_tvl_ext_001", // Thiruvallur Bus Stand
      "custom_tvl_ext_002", // Thiruvallur Terminal
      "custom_tvl_ext_004", // Theradi Bus Stop
      "custom_tvl_ext_005", // Thiruvallur Court Bus Stop
      "custom_tvl_ext_009", // SBI Bus Stop (JN Road)
      "custom_tvl_004",     // Poonamallee Municipality / Kumananchavadi
      "custom_tvl_003",     // Poonamallee Bypass (Near Bus Depot)
      "custom_tvl_002",     // Poonamallee Bypass
      "custom_tvl_001",     // Poonamallee Bus Stand
      "custom_tvl_005",     // BSNL Exchange Bus Stop (Poonamallee)
      "custom_tvl_007",     // Avadi Check Post
      "custom_tvl_008",     // Avadi Market Bus Stop
      "custom_tvl_006"      // Avadi Bus Stand
    ],
    coordinates: [
      [13.1386, 79.9076],
      [13.1405, 79.9080],
      [13.1433, 79.9088],
      [13.1370, 79.9176],
      [13.1354, 79.9087],
      [13.0451, 80.1160],
      [13.0520, 80.0907],
      [13.0504, 80.0890],
      [13.0517, 80.0948],
      [13.0513, 80.0897],
      [13.1193, 80.0942],
      [13.1159, 80.1053],
      [13.1202, 80.1021]
    ]
  }

  ],
  STOP_NAMES
};

// For backward compatibility, export routes directly
module.exports.routes = module.exports.routes;
module.exports.STOP_NAMES = STOP_NAMES;
