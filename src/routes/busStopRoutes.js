const express = require('express');
const router = express.Router();
const { getBusStops, filterByBoundingBox, limitResults, clearCache, BOUNDING_BOX } = require('../services/overpassService');

/**
 * GET /api/bus-stops
 * Returns bus stops for Thiruvallur and Vellore from Overpass API
 * REQUIRED query params for bounding box filtering:
 * ?minLat=&maxLat=&minLng=&maxLng=
 */
router.get('/', async (req, res) => {
  try {
    console.log('[API] GET /bus-stops - fetching from Overpass API');

    const { minLat, maxLat, minLng, maxLng } = req.query;

    // Fetch all bus stops from Overpass (with caching)
    let stops = await getBusStops();

    // Enforce bounding box filtering - REQUIRED
    if (!minLat || !maxLat || !minLng || !maxLng) {
      console.log('[API] Bounding box not provided, returning default region stops');
      // Use default bounding box for Thiruvallur + Vellore
      stops = filterByBoundingBox(
        stops,
        BOUNDING_BOX.minLat,
        BOUNDING_BOX.maxLat,
        BOUNDING_BOX.minLng,
        BOUNDING_BOX.maxLng
      );
    } else {
      stops = filterByBoundingBox(
        stops,
        parseFloat(minLat),
        parseFloat(maxLat),
        parseFloat(minLng),
        parseFloat(maxLng)
      );
    }

    // Limit results to prevent UI overload
    stops = limitResults(stops);

    res.json({
      success: true,
      count: stops.length,
      stops: stops
    });
  } catch (error) {
    console.error('[API] Error fetching bus stops:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bus stops from Overpass API',
      message: error.message
    });
  }
});

/**
 * GET /api/bus-stops/refresh
 * Force refresh cache and fetch fresh data from Overpass
 */
router.get('/refresh', async (req, res) => {
  try {
    console.log('[API] GET /bus-stops/refresh - forcing cache refresh');

    // Clear cache using proper function
    clearCache();

    // Fetch fresh data
    const stops = await getBusStops();

    // Apply default bounding box filtering
    stops = filterByBoundingBox(
      stops,
      BOUNDING_BOX.minLat,
      BOUNDING_BOX.maxLat,
      BOUNDING_BOX.minLng,
      BOUNDING_BOX.maxLng
    );

    // Limit results
    stops = limitResults(stops);

    res.json({
      success: true,
      count: stops.length,
      stops: stops,
      message: 'Cache refreshed successfully'
    });
  } catch (error) {
    console.error('[API] Error refreshing bus stops:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh bus stops from Overpass API',
      message: error.message
    });
  }
});

module.exports = router;
