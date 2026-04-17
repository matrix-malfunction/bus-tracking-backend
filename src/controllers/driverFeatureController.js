const DriverEmergency = require("../models/DriverEmergency");
const BusLocation = require("../models/BusLocation");

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

    const latestBusLocation = await BusLocation.findOne({ busId }).lean();
    const latitude = Number(latestBusLocation?.lat);
    const longitude = Number(latestBusLocation?.lng);

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

    const io = req.app.get("io");

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

module.exports = {
  reportDriverEmergency,
  triggerSos,
};
