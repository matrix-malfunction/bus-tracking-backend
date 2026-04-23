/**
 * Migration Script: Move location data from Location model to Bus model
 * Run this after deploying the merged backend
 */

const mongoose = require("mongoose");
const Location = require("../src/models/Location");
const Bus = require("../src/models/Bus");

require("dotenv").config();

async function migrate() {
  try {
    // Connect to database
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://localhost:27017/bus_tracking"
    );
    console.log("[MIGRATE] Connected to database");

    // Get all locations
    const locations = await Location.find({});
    console.log(`[MIGRATE] Found ${locations.length} location records`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const loc of locations) {
      try {
        // Skip if no coordinates
        if (!loc.latitude && !loc.lat) {
          console.log(`[MIGRATE] Skipping ${loc.busId} - no coordinates`);
          skipped++;
          continue;
        }

        const lat = loc.latitude || loc.lat;
        const lng = loc.longitude || loc.lng;

        // Update or create Bus record with geospatial data
        await Bus.findOneAndUpdate(
          { busId: loc.busId },
          {
            $set: {
              busId: loc.busId,
              location: {
                type: "Point",
                coordinates: [lng, lat],
              },
              latitude: lat,
              longitude: lng,
              lat: lat,
              lng: lng,
              speed: loc.speed || 0,
              routeId: loc.routeId || null,
              source: loc.source || "mobile",
              mobileSnapshot: loc.mobileSnapshot || null,
              esp32Snapshot: loc.esp32Snapshot || null,
              timestamp: loc.timestamp || loc.updatedAt,
              lastUpdate: loc.updatedAt || new Date(),
              status: "active",
            },
          },
          { upsert: true, new: true }
        );

        migrated++;

        if (migrated % 100 === 0) {
          console.log(`[MIGRATE] Progress: ${migrated}/${locations.length}`);
        }
      } catch (err) {
        console.error(`[MIGRATE] Error migrating ${loc.busId}:`, err.message);
        errors++;
      }
    }

    console.log("\n[MIGRATE] Migration complete:");
    console.log(`  Migrated: ${migrated}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Errors: ${errors}`);

    // Create geospatial index
    console.log("\n[MIGRATE] Creating geospatial index...");
    await Bus.collection.createIndex({ location: "2dsphere" });
    console.log("[MIGRATE] Geospatial index created");
  } catch (error) {
    console.error("[MIGRATE] Fatal error:", error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("[MIGRATE] Database connection closed");
  }
}

// Run if executed directly
if (require.main === module) {
  migrate();
}

module.exports = migrate;
