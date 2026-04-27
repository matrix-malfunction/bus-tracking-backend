const express = require("express");
const router = express.Router();
const Bus = require("../models/Bus");
const DriverEmergency = require("../models/DriverEmergency");

/**
 * SOS Auto-Expire: Mark SOS buses as inactive if no update for 60 seconds
 */
async function expireStaleSOS() {
  const SOS_EXPIRE_MS = 60 * 1000; // 60 seconds
  const cutoff = new Date(Date.now() - SOS_EXPIRE_MS);
  
  await Bus.updateMany(
    { 
      status: 'SOS',
      lastUpdate: { $lt: cutoff }
    },
    { $set: { status: 'inactive' } }
  );
}

/**
 * Bus Tracking Routes (Merged from bus-tracker-backend)
 * Provides geospatial queries and real-time streaming
 * Mount at: /api/buses
 */

/**
 * GET /api/buses/debug/all
 * DEBUG: List all buses in database (no filters)
 */
router.get("/debug/all", async (req, res) => {
  try {
    const buses = await Bus.find({}).select("busId lat lng status lastUpdate -_id").lean();
    console.log("[DEBUG /buses/debug/all] Total buses:", buses.length);
    buses.forEach((bus, i) => {
      console.log(`[DEBUG] Bus ${i}:`, bus);
    });
    res.json({
      count: buses.length,
      buses: buses
    });
  } catch (error) {
    console.error("[DEBUG /buses/debug/all] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/buses/nearby
 * Query params:
 *   - lat: User latitude (required)
 *   - lng: User longitude (required)
 *   - radius: Search radius in meters (default: 5000, max: 5000)
 *   - limit: Max results (default: 50, max: 100)
 *   - compact: Return compact field names (default: false)
 */
router.get("/nearby", async (req, res) => {
  try {
    // Auto-expire stale SOS before querying
    await expireStaleSOS();
    
    const { lat, lng, radius = 5000, limit = 50, compact = "false" } =
      req.query;

    // Validation
    if (!lat || !lng) {
      return res.status(400).json({
        error: "Missing required params: lat, lng",
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({
        error: "Invalid lat or lng: must be valid numbers",
      });
    }

    const searchRadius = Math.min(parseInt(radius), 5000); // Max 5km
    const LIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes for isLive flag
    const resultLimit = Math.min(parseInt(limit), 100);
    const useCompact = compact === "true";

    const now = Date.now();
    const liveThreshold = new Date(now - LIVE_THRESHOLD_MS);

    // DEBUG: Log query parameters
    console.log("[DEBUG /buses/nearby] Query:", { 
      lat: latitude, 
      lng: longitude, 
      radius: searchRadius,
      liveThreshold: liveThreshold.toISOString()
    });

    // Geospatial query
    const buses = await Bus.findNearby(
      latitude,
      longitude,
      searchRadius,
      resultLimit
    );

    // DEBUG: Log results
    console.log("[DEBUG /buses/nearby] Found:", buses.length, "buses");
    if (buses.length > 0) {
      buses.forEach((bus, i) => {
        console.log(`[DEBUG /buses/nearby] Bus ${i}:`, {
          busId: bus.busId,
          lat: bus.lat,
          lng: bus.lng,
          status: bus.status,
          lastUpdate: bus.lastUpdate
        });
      });
    }

    // Add isLive flag to each bus
    const busesWithLiveFlag = buses.map((b) => ({
      ...b,
      isLive: new Date(b.lastUpdate) >= liveThreshold
    }));

    // Fetch recent SOS alerts (last 5 minutes) - using createdAt (mongoose timestamps)
    const SOS_THRESHOLD_MS = 5 * 60 * 1000;
    const sosThreshold = new Date(now - SOS_THRESHOLD_MS);

    // DEBUG: Get raw SOS data first (no filter)
    const rawSOS = await DriverEmergency.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
    console.log("🚨 DEBUG RAW SOS:", rawSOS.length, "records");
    if (rawSOS.length > 0) {
      console.log("🚨 DEBUG FIRST SOS:", JSON.stringify(rawSOS[0], null, 2));
    }

    // Filter by createdAt (correct field from mongoose timestamps) and not acknowledged
    const recentSOS = await DriverEmergency.find({
      createdAt: { $gte: sosThreshold },
      acknowledged: { $ne: true }
    }).select("busId createdAt location -_id").lean();

    console.log("[DEBUG /buses/nearby] Found:", recentSOS.length, "SOS alerts");

    // Format SOS data - DEDUPLICATE: keep only latest per busId
    const sosByBusId = new Map();
    recentSOS.forEach(sos => {
      const existing = sosByBusId.get(sos.busId);
      if (!existing || new Date(sos.createdAt) > new Date(existing.createdAt)) {
        sosByBusId.set(sos.busId, sos);
      }
    });
    
    const formattedSOS = Array.from(sosByBusId.values()).map(sos => ({
      busId: sos.busId,
      timestamp: sos.createdAt,
      location: sos.location
    }));
    
    console.log("[DEBUG /buses/nearby] Deduplicated:", formattedSOS.length, "SOS alerts");

    // TEMP: Hardcode test bus if empty to verify pipeline
    if (busesWithLiveFlag.length === 0) {
      console.log("[DEBUG /buses/nearby] NO BUSES FOUND - injecting test bus");
      busesWithLiveFlag.push({
        busId: 'TEST001',
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        lat: parseFloat(latitude),
        lng: parseFloat(longitude),
        speed: 25,
        heading: 90,
        route: 'Test Route',
        lastUpdate: new Date(),
        isLive: true,
        status: 'active'
      });
    }

    // Format response
    const response = {
      meta: {
        query: { lat: latitude, lng: longitude, radius: searchRadius },
        count: busesWithLiveFlag.length,
        timestamp: now,
        liveCount: busesWithLiveFlag.filter(b => b.isLive).length,
        staleCount: busesWithLiveFlag.filter(b => !b.isLive).length,
        message: busesWithLiveFlag.length === 0 ? "No active buses in your area" : undefined,
        sosCount: formattedSOS.length,
      },
      buses: useCompact
        ? busesWithLiveFlag.map((b) => ({
            i: b.busId,
            la: b.lat || b.location?.coordinates?.[1],
            ln: b.lng || b.location?.coordinates?.[0],
            s: b.speed || 0,
            h: b.heading || null,
            r: b.route || null,
            t: new Date(b.lastUpdate).getTime(),
            live: b.isLive,
            st: b.status,  // status: active, SOS, etc.
          }))
        : busesWithLiveFlag.map((b) => ({
            ...b,
            isLive: b.isLive,  // Add computed live flag
          })),
      sos: formattedSOS,  // SOS data included
    };

    res.json(response);
  } catch (error) {
    console.error("[API /buses/nearby]", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/buses/bounds
 * Query params:
 *   - north, south, east, west: Bounding box (required)
 *   - limit: Max results (default: 100)
 *   - zoom: Map zoom level (for adaptive detail)
 */
router.get("/bounds", async (req, res) => {
  try {
    // Auto-expire stale SOS before querying
    await expireStaleSOS();
    
    const { north, south, east, west, zoom = 12, limit = 100 } = req.query;

    if (!north || !south || !east || !west) {
      return res.status(400).json({
        error: "Missing required params: north, south, east, west",
      });
    }

    const bounds = {
      north: parseFloat(north),
      south: parseFloat(south),
      east: parseFloat(east),
      west: parseFloat(west),
    };

    const resultLimit = Math.min(parseInt(limit), 200);

    const buses = await Bus.findInBounds(
      bounds.north,
      bounds.south,
      bounds.east,
      bounds.west,
      resultLimit
    );

    // Adaptive clustering for low zoom levels
    let responseBuses = buses;
    const zoomLevel = parseInt(zoom);
    if (zoomLevel <= 10 && buses.length > 50) {
      responseBuses = clusterBuses(buses, zoomLevel);
    }

    res.json({
      meta: {
        bounds,
        count: responseBuses.length,
        total: buses.length,
        clustered: buses.length !== responseBuses.length,
        zoom: zoomLevel,
        timestamp: Date.now(),
      },
      buses: responseBuses,
    });
  } catch (error) {
    console.error("[API /buses/bounds]", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/buses/stream
 * Server-sent events for real-time updates
 * Query params: Same as /nearby
 */
router.get("/stream", async (req, res) => {
  try {
    // Auto-expire stale SOS before querying
    await expireStaleSOS();
    
    const { lat, lng, radius = 5000 } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: "Missing lat, lng" });
    }

    // Setup SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const clientId = Date.now();
    console.log(`[STREAM] Client ${clientId} connected`);

    // Send initial data
    const buses = await Bus.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(radius),
      50
    );

    res.write(
      `data: ${JSON.stringify({
        type: "init",
        buses: buses.map((b) => ({
          i: b.busId,
          la: b.latitude || b.location?.coordinates?.[1],
          ln: b.longitude || b.location?.coordinates?.[0],
          s: b.speed || 0,
          h: b.heading || null,
          r: b.route || null,
          t: new Date(b.lastUpdate).getTime(),
          st: b.status
        })),
      })}\n\n`
    );

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(`:ping\n\n`);
    }, 30000);

    // Cleanup on disconnect
    req.on("close", () => {
      console.log(`[STREAM] Client ${clientId} disconnected`);
      clearInterval(keepAlive);
    });
  } catch (error) {
    console.error("[API /buses/stream]", error);
    res.status(500).json({ error: "Stream error" });
  }
});

/**
 * GET /api/buses/:id
 * Single bus details
 */
router.get("/:id", async (req, res) => {
  try {
    const bus = await Bus.findOne(
      { busId: req.params.id },
      { __v: 0, _id: 0 }
    ).lean();

    if (!bus) {
      return res.status(404).json({ error: "Bus not found" });
    }

    res.json({
      bus: {
        i: bus.busId,
        la: bus.latitude || bus.location?.coordinates?.[1],
        ln: bus.longitude || bus.location?.coordinates?.[0],
        s: bus.speed,
        h: bus.heading,
        r: bus.route,
        rt: bus.routeId,
        d: bus.destination,
        e: bus.eta,
        c: bus.capacity,
        o: bus.occupancy,
        st: bus.status,
        t: new Date(bus.lastUpdate).getTime(),
      },
    });
  } catch (error) {
    console.error("[API /buses/:id]", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/buses
 * List all buses (backward compatible with /api/location/all)
 */
router.get("/", async (req, res) => {
  try {
    const { compact = "false" } = req.query;
    const useCompact = compact === "true";

    const buses = await Bus.getAllActive();

    res.json({
      count: buses.length,
      timestamp: Date.now(),
      buses: useCompact
        ? buses.map((b) => ({
            i: b.busId,
            la: b.latitude,
            ln: b.longitude,
            s: b.speed || 0,
            t: new Date(b.lastUpdate).getTime(),
          }))
        : buses.map((b) => b.toLegacyJSON?.() || b),
    });
  } catch (error) {
    console.error("[API /buses]", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper: Cluster buses for low zoom
function clusterBuses(buses, zoom) {
  const gridSize = zoom <= 8 ? 0.5 : 0.2; // degrees
  const clusters = new Map();

  buses.forEach((bus) => {
    const lat =
      bus.latitude || bus.location?.coordinates?.[1] || bus.lat;
    const lng =
      bus.longitude || bus.location?.coordinates?.[0] || bus.lng;

    const gridLat = Math.floor(lat / gridSize) * gridSize;
    const gridLng = Math.floor(lng / gridSize) * gridSize;
    const key = `${gridLat.toFixed(2)},${gridLng.toFixed(2)}`;

    if (!clusters.has(key)) {
      clusters.set(key, {
        buses: [],
        latSum: 0,
        lngSum: 0,
      });
    }

    const cluster = clusters.get(key);
    cluster.buses.push(bus);
    cluster.latSum += lat;
    cluster.lngSum += lng;
  });

  return Array.from(clusters.values()).map((c) => ({
    _isCluster: true,
    clusterCount: c.buses.length,
    latitude: c.latSum / c.buses.length,
    longitude: c.lngSum / c.buses.length,
    buses: c.buses,
  }));
}

// SOS Acknowledgment endpoint
router.post("/sos/ack", async (req, res) => {
  try {
    const { busId } = req.body;
    
    if (!busId) {
      return res.status(400).json({ error: "busId is required" });
    }

    // Mark all SOS entries for this bus as acknowledged
    const result = await DriverEmergency.updateMany(
      { busId },
      { $set: { acknowledged: true } }
    );

    console.log("[SOS ACK] Acknowledged", result.modifiedCount, "entries for bus:", busId);

    // Emit real-time clear event to all clients
    const io = req.app.get("io");
    if (io) {
      io.emit("sos:cleared", { busId });
      console.log("[SOCKET] Emitted sos:cleared for bus:", busId);
    }

    res.json({ success: true, modifiedCount: result.modifiedCount });

  } catch (err) {
    console.error("[SOS ACK ERROR]", err);
    res.status(500).json({ error: "Failed to acknowledge SOS" });
  }
});

// SOS Status endpoint - Check if SOS is active for a bus
router.get("/sos/status", async (req, res) => {
  try {
    const { busId } = req.query;

    if (!busId) {
      return res.status(400).json({ error: "busId is required" });
    }

    const activeSOS = await DriverEmergency.findOne({
      busId,
      acknowledged: { $ne: true }
    });

    res.json({ active: !!activeSOS });

  } catch (err) {
    console.error("[SOS STATUS ERROR]", err);
    res.status(500).json({ error: "Failed to check SOS status" });
  }
});

module.exports = router;
