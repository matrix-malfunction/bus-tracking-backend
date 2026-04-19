const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    busId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    lat: {
      type: Number,
      default: null,
    },
    lng: {
      type: Number,
      default: null,
    },
    speed: {
      type: Number,
      default: 0,
    },
    source: {
      type: String,
      default: "mobile",
    },
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      default: null,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        default: undefined,
      },
    },
    mobileSnapshot: {
      lat: Number,
      lng: Number,
      speed: Number,
      timestamp: Date,
    },
    esp32Snapshot: {
      lat: Number,
      lng: Number,
      speed: Number,
      timestamp: Date,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

locationSchema.index({ updatedAt: -1 });
locationSchema.index({ timestamp: -1 });
locationSchema.index({ routeId: 1, updatedAt: -1 });

module.exports = mongoose.model("Location", locationSchema);
