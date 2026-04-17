const PassengerSos = require("../models/PassengerSos");

async function sendPassengerSos(req, res) {
  try {
    const passengerId = String(req.user?.id || "").trim();
    const latitude = Number(req.body?.location?.latitude);
    const longitude = Number(req.body?.location?.longitude);

    if (!passengerId) {
      return res.status(401).json({ message: "Unauthorized passenger request" });
    }

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: "Valid latitude and longitude are required" });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res
        .status(400)
        .json({ message: "Latitude must be between -90..90 and longitude between -180..180" });
    }

    const record = await PassengerSos.create({
      passengerId,
      location: { latitude, longitude },
      timestamp: new Date(),
    });

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
  sendPassengerSos,
};
