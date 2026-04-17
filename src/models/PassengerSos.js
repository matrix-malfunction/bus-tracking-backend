const mongoose = require("mongoose");

const passengerSosSchema = new mongoose.Schema(
  {
    passengerId: { type: mongoose.Schema.Types.ObjectId, ref: "Passenger" },
    name: String,
    phone: String,
    location: {
      latitude: Number,
      longitude: Number,
    },
    status: { type: String, default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PassengerSos", passengerSosSchema);
