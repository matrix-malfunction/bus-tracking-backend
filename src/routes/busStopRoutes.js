const express = require('express');
const router = express.Router();
const busStops = require('../data/busStops.json');

/**
 * GET /api/bus-stops
 * Returns all bus stops for Tiruvallur and Vellore
 */
router.get('/', (req, res) => {
  console.log('[API] GET /bus-stops - returning bus stops');
  
  // Flatten all stops into a single array with region info
  const allStops = [
    ...busStops.tiruvallur.map(stop => ({ ...stop, region: 'tiruvallur' })),
    ...busStops.vellore.map(stop => ({ ...stop, region: 'vellore' }))
  ];
  
  res.json({
    success: true,
    count: allStops.length,
    stops: allStops
  });
});

/**
 * GET /api/bus-stops/:region
 * Returns bus stops for a specific region
 */
router.get('/:region', (req, res) => {
  const { region } = req.params;
  
  if (!busStops[region]) {
    return res.status(404).json({
      success: false,
      error: `Region '${region}' not found. Available: tiruvallur, vellore`
    });
  }
  
  const stops = busStops[region].map(stop => ({ ...stop, region }));
  
  res.json({
    success: true,
    region,
    count: stops.length,
    stops
  });
});

module.exports = router;
