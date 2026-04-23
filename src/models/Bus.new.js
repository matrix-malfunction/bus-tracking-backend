const mongoose = require("mongoose");

/**
 * Merged Bus Model
 * - Geospatial capabilities from bus-tracker-backend
 * - Relational fields from original backend
 * - Supports both driver updates and passenger queries
 */

const busSchema = new mongoose.Schema(
  {
    // Core identification (from both)
    busId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    
    // Route relation (from original backend)
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      default: null,
      index: true,
    },
    route: {
      type: String,
      index: true,
    },
    routeName: String,
    destination: String,

    // Geospatial location (from bus-tracker-backend)
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
    },
    
    // Legacy fields for backward compatibility during migration
    latitude: Number,
    longitude: Number,
    lat: Number,
    lng: Number,

    // Real-time telemetry (from bus-tracker-backend)
    speed: {
      type: Number,
      default: 0,
      min: 0,
      max: 100, // m/s
    },
    heading: {
      type: Number,
      default: 0,
      min: 0,
      max: 360,
    },
    
    // Source tracking (from original backend)
    source: {
      type: String,
      enum: ["mobile", "esp32", "api"],
      default: "mobile",
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

    // Capacity (from bus-tracker-backend)
    capacity: {
      type: Number,
      default: 0,
    },
    occupancy: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Status (from bus-tracker-backend)
    status: {
      type: String,
      enum: ["active", "inactive", "maintenance", "out_of_service"],
      default: "active",
      index: true,
    },

    // ETA to stops (from bus-tracker-backend)
    eta: [
      {
        stopId: String,
        stopName: String,
        arrivalTime: Date,
        delay: Number, // seconds
      },
    ],

    // Timestamps
    lastUpdate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Geospatial index for $near and $geoWithin queries
busSchema.index({ location: "2dsphere" });

// Compound indexes for common queries
busSchema.index({ status: 1, lastUpdate: -1 });
busSchema.index({ routeId: 1, status: 1 });
busSchema.index({ busId: 1, status: 1 });

// TTL index for automatic cleanup (optional)
// busSchema.index({ lastUpdate: 1 }, { expireAfterSeconds: 3600 });

// Pre-save middleware
busSchema.pre("save", function (next) {
  // Sync legacy fields with GeoJSON
  if (this.location && this.location.coordinates) {
    this.longitude = this.location.coordinates[0];
    this.latitude = this.location.coordinates[1];
    this.lng = this.location.coordinates[0];
    this.lat = this.location.coordinates[1];
  }

  // Validate coordinates
  if (this.latitude && (this.latitude < -90 || this.latitude > 90)) {
    return next(new Error("Invalid latitude: must be between -90 and 90"));
  }
  if (this.longitude && (this.longitude < -180 || this.longitude > 180)) {
    return next(new Error("Invalid longitude: must be between -180 and 180"));
  }

  // Update timestamps
  this.lastUpdate = new Date();
  this.timestamp = new Date();

  next();
});

// Static Methods

/**
 * Update bus location (used by driver app)
 */
busSchema.statics.updateLocation = async function (
  busId,
  lat,
  lng,
  speed,
  heading,
  source = "mobile"
) {
  const update = {
    $set: {
      location: {
        type: "Point",
        coordinates: [lng, lat],
      },
      latitude: lat,
      longitude: lng,
      lat: lat,
      lng: lng,
      speed,
      heading,
      source,
      lastUpdate: new Date(),
      timestamp: new Date(),
      status: "active",
    },
  };

  // Add source-specific snapshot
  if (source === "mobile") {
    update.$set.mobileSnapshot = {
      lat,
      lng,
      speed,
      timestamp: new Date(),
    };
  } else if (source === "esp32") {
    update.$set.esp32Snapshot = {
      lat,
      lng,
      speed,
      timestamp: new Date(),
    };
  }

  return this.findOneAndUpdate({ busId }, update, { upsert: true, new: true });
};

/**
 * Find nearby buses (geospatial query)
 */
busSchema.statics.findNearby = async function (lat, lng, radius, limit = 50) {
  return this.find(
    {
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [lng, lat],
          },
          $maxDistance: radius,
        },
      },
      status: "active",
      lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    {
      busId: 1,
      location: 1,
      latitude: 1,
      longitude: 1,
      speed: 1,
      heading: 1,
      route: 1,
      routeId: 1,
      lastUpdate: 1,
    }
  )
    .limit(limit)
    .lean();
};

/**
 * Find buses within bounding box
 */
busSchema.statics.findInBounds = async function (
  north,
  south,
  east,
  west,
  limit = 100
) {
  return this.find(
    {
      location: {
        $geoWithin: {
          $geometry: {
            type: "Polygon",
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        },
      },
      status: "active",
      lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    {
      busId: 1,
      location: 1,
      speed: 1,
      heading: 1,
      route: 1,
      lastUpdate: 1,
    }
  )
    .limit(limit)
    .lean();
};

/**
 * Get all active buses (backward compatible)
 */
busSchema.statics.getAllActive = async function () {
  return this.find(
    {
      status: "active",
      lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    {
      busId: 1,
      latitude: 1,
      longitude: 1,
      location: 1,
      speed: 1,
      timestamp: 1,
      lastUpdate: 1,
    }
  )
    .sort({ lastUpdate: -1 })
    .lean();
};

// Instance Methods

/**
 * Compact JSON for passenger app (short field names)
 */
busSchema.methods.toCompactJSON = function () {
  return {
    i: this.busId,
    la: this.latitude || this.location?.coordinates?.[1],
    ln: this.longitude || this.location?.coordinates?.[0],
    s: this.speed || 0,
    h: this.heading || null,
    r: this.route || null,
    t: new Date(this.lastUpdate).getTime(),
  };
};

/**
 * Legacy format for backward compatibility
 */
busSchema.methods.toLegacyJSON = function () {
  return {
    busId: this.busId,
    latitude: this.latitude,
    longitude: this.longitude,
    lat: this.lat,
    lng: this.lng,
    speed: this.speed,
    timestamp: this.lastUpdate,
  };
};

module.exports = mongoose.model("Bus", busSchema);
