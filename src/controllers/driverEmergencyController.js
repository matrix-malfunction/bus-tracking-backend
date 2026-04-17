const DriverEmergency = require("../models/DriverEmergency");

exports.createEmergency = async (req, res) => {
  try {
    const { driverId, busId, location } = req.body;

    if (
      !driverId ||
      !busId ||
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number"
    ) {
      return res.status(400).json({ message: "Missing data" });
    }

    const emergency = await DriverEmergency.create({
      driverId,
      busId,
      location,
      status: "active",
    });

    return res.json({ success: true, emergency });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};
