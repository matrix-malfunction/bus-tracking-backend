const mongoose = require("mongoose");

const stopSchema = new mongoose.Schema(
  {
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

stopSchema.index({ routeId: 1, order: 1 });

module.exports = mongoose.model("Stop", stopSchema);
