const mongoose = require('mongoose');

/**
 * Bus Schema with Geospatial Index
 * Merged from bus-tracker-backend
 */
const busSchema = new mongoose.Schema({
  busId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Geospatial location (GeoJSON Point)
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true
    }
  },
  
  // Route info
  route: {
    type: String,
    index: true
  },
  routeId: String,
  destination: String,
  
  // Real-time data
  speed: {
    type: Number,
    default: 0,
    min: 0,
    max: 100 // m/s (~360 km/h max)
  },
  heading: {
    type: Number,
    default: 0,
    min: 0,
    max: 360
  },
  
  // Capacity
  capacity: {
    type: Number,
    default: 0
  },
  occupancy: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Status
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'out_of_service'],
    default: 'active',
    index: true
  },
  
  // Calculated ETA to stops
  eta: [{
    stopId: String,
    stopName: String,
    arrivalTime: Date,
    delay: Number // seconds
  }],
  
  // Timestamps
  lastUpdate: {
    type: Date,
    default: Date.now,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  // Auto-remove stale data after 24 hours of inactivity
  expireAt: {
    type: Date,
    default: function() {
      return new Date(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
});

// Geospatial index for $near and $geoWithin queries
busSchema.index({ location: '2dsphere' });

// Compound index for common queries
busSchema.index({ status: 1, lastUpdate: -1 });
busSchema.index({ route: 1, status: 1 });

// TTL index for automatic cleanup of stale data
busSchema.index({ lastUpdate: 1 }, { expireAfterSeconds: 3600 }); // 1 hour

// Pre-save middleware for validation
busSchema.pre('save', function(next) {
  // Ensure coordinates are valid
  if (this.location && this.location.coordinates) {
    const [lng, lat] = this.location.coordinates;
    
    if (lat < -90 || lat > 90) {
      return next(new Error('Invalid latitude: must be between -90 and 90'));
    }
    if (lng < -180 || lng > 180) {
      return next(new Error('Invalid longitude: must be between -180 and 180'));
    }
  }
  
  // Update lastUpdate
  this.lastUpdate = new Date();
  
  next();
});

// Static methods
busSchema.statics.updateLocation = async function(busId, lat, lng, speed, heading) {
  return this.findOneAndUpdate(
    { busId },
    {
      $set: {
        location: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        speed,
        heading,
        lastUpdate: new Date()
      }
    },
    { upsert: true, new: true }
  );
};

busSchema.statics.findNearby = async function(lat, lng, radius, limit = 50) {
  return this.find({
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        $maxDistance: radius
      }
    },
    status: 'active',
    lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  })
  .limit(limit)
  .lean();
};

busSchema.statics.findInBounds = async function(north, south, east, west, limit = 100) {
  return this.find({
    location: {
      $geoWithin: {
        $geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south]
          ]]
        }
      }
    },
    status: 'active',
    lastUpdate: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  })
  .limit(limit)
  .lean();
};

// Instance methods
busSchema.methods.toCompactJSON = function() {
  return {
    i: this.busId,
    la: this.location.coordinates[1],
    ln: this.location.coordinates[0],
    s: this.speed,
    h: this.heading,
    r: this.route,
    t: this.lastUpdate.getTime()
  };
};

module.exports = mongoose.model('Bus', busSchema);

