const PassengerSos = require("../models/PassengerSos");

exports.createSos = async (req, res) => {
  try {
    const { passengerId, name, phone, location } = req.body;

    if (
      !passengerId ||
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number"
    ) {
      return res.status(400).json({ message: "Missing data" });
    }

    const sos = await PassengerSos.create({
      passengerId,
      name,
      phone,
      location,
    });

    return res.json({ success: true, sos });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};
