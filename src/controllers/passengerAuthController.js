const Passenger = require("../models/Passenger");

exports.loginPassenger = async (req, res) => {
  try {
    const { name, phone } = req.body;
    const normalizedPhone = String(phone || "").trim();

    if (!name || !normalizedPhone) {
      return res.status(400).json({ message: "Name and phone required" });
    }

    let passenger = await Passenger.findOne({ phone: normalizedPhone });

    if (!passenger) {
      passenger = await Passenger.create({
        name,
        phone: normalizedPhone,
      });
    }

    return res.json({
      success: true,
      passenger,
      token: passenger._id,
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};
