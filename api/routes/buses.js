const express = require('express');
const router = express.Router();
const Bus = require('../models/Bus');
const { createStream } = require('../utils/streaming');

/**
 * GET /api/buses/nearby
 * Query params:
 *   - lat: User latitude (required)
 *   - lng: User longitude (required)
 *   - radius: Search radius in meters (default: 5000)
 *   - limit: Max results (default: 50, max: 100)
 *   - fields: Comma-separated field list (default: minimal)
 */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 5000, limit = 50, fields } = req.query;

    // Validation
    if (!lat || !lng) {
      return res.status(400).json({ 
        error: 'Missing required params: lat, lng' 
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const searchRadius = Math.min(parseInt(radius), 50000); // Max 50km
    const resultLimit = Math.min(parseInt(limit), 100);

    // Build field projection (minimal by default)
    const projection = buildFieldProjection(fields);

    // Geospatial query with 2dsphere index
    const buses = await Bus.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          $maxDistance: searchRadius
        }
      },
      // Only active buses
      status: 'active',
      // Only updated in last 5 minutes (stale filter)
      lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
    }, projection)
    .limit(resultLimit)
    .lean(); // Faster, returns plain JS objects

    // Compact response format
    const response = {
      meta: {
        query: { lat: latitude, lng: longitude, radius: searchRadius },
        count: buses.length,
        timestamp: Date.now()
      },
      buses: compactBusData(buses)
    };

    // Compress if client supports it
    res.set('Content-Encoding', 'gzip');
    res.json(response);

  } catch (error) {
    console.error('[API /nearby]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/buses/bounds
 * Query params:
 *   - north, south, east, west: Bounding box (required)
 *   - limit: Max results (default: 100)
 *   - zoom: Map zoom level (for adaptive detail)
 */
router.get('/bounds', async (req, res) => {
  try {
    const { 
      north, south, east, west, 
      limit = 100, 
      zoom = 12 
    } = req.query;

    if (!north || !south || !east || !west) {
      return res.status(400).json({ 
        error: 'Missing required params: north, south, east, west' 
      });
    }

    const bounds = {
      north: parseFloat(north),
      south: parseFloat(south),
      east: parseFloat(east),
      west: parseFloat(west)
    };

    const resultLimit = Math.min(parseInt(limit), 200);

    // Bounding box query with $geoWithin
    const buses = await Bus.find({
      location: {
        $geoWithin: {
          $geometry: {
            type: 'Polygon',
            coordinates: [[
              [bounds.west, bounds.south],
              [bounds.east, bounds.south],
              [bounds.east, bounds.north],
              [bounds.west, bounds.north],
              [bounds.west, bounds.south]
            ]]
          }
        }
      },
      status: 'active',
      lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
    }, buildFieldProjection(null, zoom))
    .limit(resultLimit)
    .lean();

    // Adaptive clustering for low zoom levels
    let responseBuses = buses;
    if (parseInt(zoom) <= 10 && buses.length > 50) {
      responseBuses = clusterBuses(buses, zoom);
    }

    res.json({
      meta: {
        bounds,
        count: responseBuses.length,
        total: buses.length,
        clustered: buses.length !== responseBuses.length,
        zoom: parseInt(zoom),
        timestamp: Date.now()
      },
      buses: compactBusData(responseBuses)
    });

  } catch (error) {
    console.error('[API /bounds]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/buses/stream
 * Server-sent events for real-time updates
 * Query params: Same as /nearby
 */
router.get('/stream', async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing lat, lng' });
    }

    // Setup SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientId = Date.now();
    console.log(`[STREAM] Client ${clientId} connected`);

    // Initial data
    const buses = await getNearbyBuses(lat, lng, radius);
    res.write(`data: ${JSON.stringify({ type: 'init', buses: compactBusData(buses) })}\n\n`);

    // Subscribe to changes
    const unsubscribe = createStream(clientId, { lat, lng, radius }, (update) => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
    });

    // Cleanup on disconnect
    req.on('close', () => {
      console.log(`[STREAM] Client ${clientId} disconnected`);
      unsubscribe();
    });

  } catch (error) {
    console.error('[API /stream]', error);
    res.status(500).json({ error: 'Stream error' });
  }
});

/**
 * GET /api/buses/:id
 * Single bus details
 */
router.get('/:id', async (req, res) => {
  try {
    const bus = await Bus.findOne(
      { busId: req.params.id },
      { __v: 0, _id: 0 } // Exclude MongoDB fields
    ).lean();

    if (!bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    res.json({ bus: compactSingleBus(bus) });

  } catch (error) {
    console.error('[API /:id]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper: Build field projection for minimal payload
function buildFieldProjection(fieldsParam, zoom = 12) {
  // Default minimal fields (always include)
  const baseFields = {
    busId: 1,
    'location.coordinates': 1, // [lng, lat]
    lastUpdate: 1,
    status: 1
  };

  // If specific fields requested
  if (fieldsParam) {
    const fields = fieldsParam.split(',');
    const projection = { ...baseFields };
    fields.forEach(f => projection[f] = 1);
    return projection;
  }

  // Adaptive: Add more fields at higher zoom levels
  if (zoom >= 14) {
    return {
      ...baseFields,
      route: 1,
      speed: 1,
      heading: 1,
      eta: 1
    };
  }

  if (zoom >= 12) {
    return {
      ...baseFields,
      route: 1,
      speed: 1
    };
  }

  return baseFields; // Minimal for far zoom
}

// Helper: Compact bus data for minimal payload
function compactBusData(buses) {
  return buses.map(bus => ({
    i: bus.busId,                          // id
    la: bus.location.coordinates[1],       // lat
    ln: bus.location.coordinates[0],       // lng
    s: bus.speed || 0,                     // speed (optional)
    h: bus.heading || null,                // heading (optional)
    r: bus.route || null,                  // route (optional)
    e: bus.eta || null,                    // eta (optional)
    t: new Date(bus.lastUpdate).getTime()  // timestamp
  }));
}

// Helper: Compact single bus (full details)
function compactSingleBus(bus) {
  return {
    i: bus.busId,
    la: bus.location.coordinates[1],
    ln: bus.location.coordinates[0],
    s: bus.speed,
    h: bus.heading,
    r: bus.route,
    rt: bus.routeId,
    d: bus.destination,
    e: bus.eta,
    c: bus.capacity,
    o: bus.occupancy,
    st: bus.status,
    t: new Date(bus.lastUpdate).getTime()
  };
}

// Helper: Get nearby buses
async function getNearbyBuses(lat, lng, radius) {
  return await Bus.find({
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [parseFloat(lng), parseFloat(lat)]
        },
        $maxDistance: parseInt(radius)
      }
    },
    status: 'active',
    lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  }, {
    busId: 1,
    'location.coordinates': 1,
    speed: 1,
    heading: 1,
    route: 1,
    eta: 1,
    lastUpdate: 1
  }).limit(50).lean();
}

// Helper: Cluster buses for low zoom
function clusterBuses(buses, zoom) {
  // Simple grid clustering
  const gridSize = zoom <= 8 ? 0.5 : 0.2; // degrees
  const clusters = new Map();

  buses.forEach(bus => {
    const lat = bus.location.coordinates[1];
    const lng = bus.location.coordinates[0];
    
    // Grid key
    const gridLat = Math.floor(lat / gridSize) * gridSize;
    const gridLng = Math.floor(lng / gridSize) * gridSize;
    const key = `${gridLat.toFixed(2)},${gridLng.toFixed(2)}`;

    if (!clusters.has(key)) {
      clusters.set(key, {
        ...bus,
        _clusterCount: 1,
        _clusterBounds: { minLat: lat, maxLat: lat, minLng: lng, maxLng: lng }
      });
    } else {
      const existing = clusters.get(key);
      existing._clusterCount++;
      existing._clusterBounds.minLat = Math.min(existing._clusterBounds.minLat, lat);
      existing._clusterBounds.maxLat = Math.max(existing._clusterBounds.maxLat, lat);
      existing._clusterBounds.minLng = Math.min(existing._clusterBounds.minLng, lng);
      existing._clusterBounds.maxLng = Math.max(existing._clusterBounds.maxLng, lng);
    }
  });

  // Convert clusters to bus format with cluster info
  return Array.from(clusters.values()).map(c => ({
    ...c,
    _isCluster: c._clusterCount > 1,
    clusterCount: c._clusterCount,
    // Center position
    location: {
      coordinates: [
        (c._clusterBounds.minLng + c._clusterBounds.maxLng) / 2,
        (c._clusterBounds.minLat + c._clusterBounds.maxLat) / 2
      ]
    }
  }));
}

module.exports = router;
