const mongoose = require("mongoose");

const busLocationSchema = new mongoose.Schema({
  busId: { type: String, required: true, unique: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  source: String,
  updatedAt: Date,
});

module.exports = mongoose.model("BusLocation", busLocationSchema);
