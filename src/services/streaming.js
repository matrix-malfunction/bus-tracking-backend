const EventEmitter = require('events');
const Bus = require('../models/Bus');

/**
 * Real-time streaming system for bus updates
 * Supports both polling and pub/sub patterns
 * Merged from bus-tracker-backend
 */

class BusStreamManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // clientId -> { filters, lastUpdate, socket }
    this.updateInterval = null;
    this.isRunning = false;
    this.lastBroadcastTime = 0;
  }

  /**
   * Start the update loop
   */
  start(updateFrequencyMs = 1000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('[STREAM] Starting update loop:', updateFrequencyMs, 'ms');
    
    // Poll for changes and broadcast
    this.updateInterval = setInterval(() => {
      this.broadcastUpdates();
    }, updateFrequencyMs);
  }

  /**
   * Stop the update loop
   */
  stop() {
    this.isRunning = false;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('[STREAM] Stopped');
  }

  /**
   * Subscribe a client to real-time updates
   */
  subscribe(clientId, filters = {}, onUpdate) {
    console.log(`[STREAM] Client ${clientId} subscribed`);
    
    this.clients.set(clientId, {
      filters,
      lastUpdate: new Date(0),
      onUpdate,
      connectedAt: Date.now()
    });

    // Send initial data
    this.sendInitialData(clientId);

    // Return unsubscribe function
    return () => {
      this.unsubscribe(clientId);
    };
  }

  /**
   * Unsubscribe a client
   */
  unsubscribe(clientId) {
    console.log(`[STREAM] Client ${clientId} unsubscribed`);
    this.clients.delete(clientId);
  }

  /**
   * Send initial data to new subscriber
   */
  async sendInitialData(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const { lat, lng, radius = 50000 } = client.filters; // Increased to 50km for testing
      
      // Stage 2: Backend Streaming - Query LIVE buses
      const buses = await Bus.findNearby(
        parseFloat(lat),
        parseFloat(lng),
        parseInt(radius),
        50
      );
      
      const normalizedBuses = buses
        .map(b => compactBus(b))
        .filter(b => b !== null);
      
      console.log("[BACKEND] Emitting buses:", normalizedBuses.length);

      client.onUpdate({
        type: 'BUS_DATA',
        timestamp: Date.now(),
        count: normalizedBuses.length,
        buses: normalizedBuses
      });

      client.lastUpdate = new Date();

    } catch (error) {
      console.error(`[STREAM] Error sending initial data to ${clientId}:`, error);
    }
  }

  /**
   * Broadcast updates to all subscribed clients
   */
  async broadcastUpdates() {
    if (this.clients.size === 0) return;

    const now = Date.now();
    
    // Throttle broadcasts (max 1 per second)
    if (now - this.lastBroadcastTime < 1000) return;
    this.lastBroadcastTime = now;

    // Group clients by filter area for efficient queries
    const clientGroups = this.groupClientsByArea();

    for (const [areaKey, clients] of clientGroups) {
      try {
        // Query once for all clients in this area
        const [lat, lng, radius] = areaKey.split(',').map(Number);
        
        const updatedBuses = await Bus.find({
          location: {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [lng, lat]
              },
              $maxDistance: radius
            }
          },
          lastUpdate: {
            $gte: new Date(now - 5 * 60 * 1000) // Updated in last 5 min (relaxed)
          }
        })
        .select('busId location.coordinates speed heading route lastUpdate')
        .limit(100)
        .lean();

        // Debug logging
        console.log("[STREAM DEBUG] Area:", lat, lng, "Radius:", radius, "Found buses:", updatedBuses.length);
        updatedBuses.forEach(bus => {
          console.log("[STREAM DEBUG] Bus:", bus.busId, "lastUpdate:", bus.lastUpdate);
        });

        // TEMP: Send ALL buses without filtering to test pipeline
        // Send to each client in this group
        for (const clientId of clients) {
          const client = this.clients.get(clientId);
          if (!client) continue;

          // TEMP TEST: Skip incremental filtering, send all
          const changes = updatedBuses; // .filter(bus => 
            // new Date(bus.lastUpdate) > client.lastUpdate
          // );

          // TEMP: Hardcode test bus if empty
          let finalChanges = changes;
          if (changes.length === 0) {
            console.log("[STREAM DEBUG] No changes found, injecting test bus");
            finalChanges = [{
              busId: 'TEST001',
              latitude: parseFloat(lat),
              longitude: parseFloat(lng),
              speed: 25,
              eta: '5 min',
              route: 'Test Route',
              status: 'active'
            }];
          }

          console.log("[STREAM EMIT] Client:", clientId, "Buses:", finalChanges.length);
          console.log("[STREAM PAYLOAD]:", JSON.stringify(finalChanges[0]));

          client.onUpdate({
            type: 'update',
            timestamp: now,
            count: finalChanges.length,
            buses: finalChanges.map(b => compactBus(b))
          });

          client.lastUpdate = new Date();
        }

      } catch (error) {
        console.error('[STREAM] Broadcast error:', error);
      }
    }
  }

  /**
   * Group clients by similar filter areas for batch queries
   */
  groupClientsByArea() {
    const groups = new Map();
    const gridSize = 0.1; // ~10km grid

    for (const [clientId, client] of this.clients) {
      const { lat, lng, radius = 5000 } = client.filters;
      
      // Snap to grid
      const gridLat = Math.floor(parseFloat(lat) / gridSize) * gridSize;
      const gridLng = Math.floor(parseFloat(lng) / gridSize) * gridSize;
      const key = `${gridLat},${gridLng},${radius}`;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(clientId);
    }

    return groups;
  }

  /**
   * Get active client count
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Get system stats
   */
  getStats() {
    return {
      activeClients: this.clients.size,
      isRunning: this.isRunning,
      uptime: process.uptime()
    };
  }
}

// Singleton instance
const streamManager = new BusStreamManager();

/**
 * Create a new stream subscription
 */
function createStream(clientId, filters, onUpdate) {
  return streamManager.subscribe(clientId, filters, onUpdate);
}

/**
 * Compact bus data for minimal payload
 */
function compactBus(bus) {
  // Normalize and validate status
  const status = String(bus.status || "").toLowerCase();
  if (status !== "active" && status !== "sos") return null;
  
  // Safety: reject if _id missing
  const id = bus._id;
  if (!id) {
    console.warn("[BACKEND] Dropped bus: missing _id");
    return null;
  }
  
  // Safety: validate location object
  const location = bus.location;
  if (
    !location ||
    typeof location !== "object" ||
    !Array.isArray(location.coordinates) ||
    location.coordinates.length < 2
  ) {
    console.warn("[BACKEND] Dropped bus: invalid location");
    return null;
  }
  
  const lng = location.coordinates[0];
  const lat = location.coordinates[1];
  
  // Safety: reject if coords invalid
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    console.warn("[BACKEND] Dropped bus: invalid coords");
    return null;
  }
  
  return {
    _id: String(id),
    lat: lat,
    lng: lng,
    status: status,
    speed: bus.speed || 0,
    heading: bus.heading || null,
    route: bus.route || null,
    lastUpdate: new Date(bus.lastUpdate).getTime()
  };
}

/**
 * Publish a bus update (called by GPS receiver)
 */
async function publishBusUpdate(busData) {
  // Save to database
  const bus = await Bus.updateLocation(
    busData.busId,
    busData.lat,
    busData.lng,
    busData.speed,
    busData.heading
  );

  // Emit event for real-time subscribers
  streamManager.emit('busUpdate', bus);

  return bus;
}

/**
 * Setup Change Stream for MongoDB (for real-time DB changes)
 */
async function setupChangeStream() {
  if (!Bus.watch) {
    console.log('[STREAM] Change streams not supported');
    return;
  }

  try {
    const changeStream = Bus.watch([
      {
        $match: {
          'fullDocument.status': 'active',
          'fullDocument.location.coordinates': { $exists: true, $type: 'array' },
          operationType: { $in: ['insert', 'update', 'replace'] }
        }
      }
    ]);

    changeStream.on('change', (change) => {
      // Broadcast to interested clients
      streamManager.emit('dbChange', change);
    });

    console.log('[STREAM] MongoDB change stream active');

  } catch (error) {
    console.error('[STREAM] Change stream error:', error);
  }
}

module.exports = {
  streamManager,
  createStream,
  publishBusUpdate,
  setupChangeStream,
  compactBus
};
