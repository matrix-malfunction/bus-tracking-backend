const jwt = require("jsonwebtoken");
const Passenger = require("../models/Passenger");
const env = require("../config/env");

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

    // Generate proper JWT token for middleware compatibility
    const token = jwt.sign(
      {
        id: passenger._id,
        role: "passenger",
        name: passenger.name,
      },
      env.jwtSecret,
      { expiresIn: "1d" }
    );

    return res.json({
      success: true,
      passenger: {
        id: passenger._id,
        name: passenger.name,
        phone: passenger.phone,
      },
      token,
    });
  } catch (err) {
    console.error("Passenger login error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
};
