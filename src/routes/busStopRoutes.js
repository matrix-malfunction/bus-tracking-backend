const express = require('express');
const router = express.Router();
const { getBusStops, clearCache } = require('../services/overpassService');

/**
 * GET /api/bus-stops
 * Returns all bus stops (Overpass + curated BUS_STOPS)
 * BUS_STOPS are always included regardless of bounding box
 */
router.get('/', async (req, res) => {
  try {
    console.log('[API] GET /bus-stops - fetching from Overpass API');

    // Fetch all bus stops (merged overpass + BUS_STOPS from getBusStops)
    let stops = await getBusStops();
    console.log(`[API] Total stops before filtering: ${stops.length}`);

    // Note: BUS_STOPS are already included in getBusStops() result
    // They are NOT filtered by bounding box - they are always included
    // Only overpass results might be filtered in the service layer

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

    // Fetch fresh data (includes BUS_STOPS without filtering)
    const stops = await getBusStops();
    console.log(`[API] Refresh - total stops: ${stops.length}`);

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
