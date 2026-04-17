const mongoose = require("mongoose");

const scheduleStopSchema = new mongoose.Schema(
  {
    stopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stop",
      required: true,
    },
    time: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const scheduleSchema = new mongoose.Schema(
  {
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      required: true,
      index: true,
      unique: true,
    },
    stops: {
      type: [scheduleStopSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Schedule", scheduleSchema);
