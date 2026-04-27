const mongoose = require("mongoose");

const driverEmergencySchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver" },
    busId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      default: "breakdown",
      enum: ["breakdown"],
    },
    location: {
      latitude: {
        type: Number,
        required: true,
      },
      longitude: {
        type: Number,
        required: true,
      },
    },
    status: { type: String, default: "active" },
    acknowledged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

driverEmergencySchema.index({ driverId: 1, createdAt: -1 });

// Compound index for SOS query optimization (busId + lastUpdate TTL + createdAt sort)
driverEmergencySchema.index({ busId: 1, lastUpdate: -1, createdAt: -1 });

module.exports = mongoose.model("DriverEmergency", driverEmergencySchema);
