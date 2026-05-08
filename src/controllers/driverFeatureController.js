const DriverEmergency = require("../models/DriverEmergency");
const Bus = require("../models/Bus");
const { setSosState, acknowledgeSos } = require("../utils/trackingState");

async function reportDriverEmergency(req, res) {
  try {
    const busId = String(req.body?.busId || "").trim();
    const type = "breakdown";
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (!busId) {
      return res.status(400).json({ message: "busId is required" });
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: "Valid latitude and longitude are required" });
    }

    const record = await DriverEmergency.create({
      busId,
      type,
      location: {
        latitude,
        longitude,
      },
      timestamp: new Date(),
    });

    return res.status(201).json({
      message: "Driver emergency reported",
      emergencyId: record._id,
      type: record.type,
      timestamp: record.timestamp,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to report driver emergency" });
  }
}

async function triggerSos(req, res) {
  try {
    const busId = String(req.body?.busId || "").trim();
    if (!busId) {
      return res.status(400).json({ message: "busId is required" });
    }

    const latestBus = await Bus.findOne({ busId }).lean();
    const latitude = Number(latestBus?.location?.coordinates?.[1] || latestBus?.lat);
    const longitude = Number(latestBus?.location?.coordinates?.[0] || latestBus?.lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: "No valid bus location available for SOS" });
    }

    const record = await DriverEmergency.create({
      busId,
      type: "breakdown",
      location: {
        latitude,
        longitude,
      },
      timestamp: new Date(),
    });

    // Set SOS flag but KEEP tracking active for real-time updates
    const io = req.app.get("io");
    setSosState(busId, true, io, { lat: latitude, lng: longitude });
    console.log("[SOS] SOS flag set for bus (tracking continues):", busId);

    if (io) {
      io.emit("sosAlert", {
        busId: req.body.busId,
        message: "Emergency triggered",
        time: new Date(),
      });

      console.log("🚨 SOS EMITTED:", req.body.busId);
    }

    return res.status(201).json({
      message: "SOS created",
      sosId: record._id,
      timestamp: record.timestamp,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create SOS" });
  }
}

async function acknowledgeSosController(req, res) {
  try {
    const busId = String(req.body?.busId || "").trim();
    if (!busId) {
      return res.status(400).json({ message: "busId is required" });
    }

    const io = req.app.get("io");
    
    // Use trackingState to acknowledge SOS
    const success = acknowledgeSos(busId, io);
    
    if (!success) {
      return res.status(400).json({ message: "No active SOS for this bus" });
    }

    return res.status(200).json({
      message: "SOS acknowledged",
      busId,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("[SOS ACK] Error:", error);
    return res.status(500).json({ message: "Failed to acknowledge SOS" });
  }
}

module.exports = {
  reportDriverEmergency,
  triggerSos,
  acknowledgeSos: acknowledgeSosController,
};
