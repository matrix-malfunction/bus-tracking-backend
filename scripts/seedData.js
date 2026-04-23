const mongoose = require('mongoose');
const Bus = require('../models/Bus');

/**
 * Seed test data for load testing
 */

const CITIES = {
  nyc: { lat: 40.7128, lng: -74.0060, name: 'New York' },
  la: { lat: 34.0522, lng: -118.2437, name: 'Los Angeles' },
  chicago: { lat: 41.8781, lng: -87.6298, name: 'Chicago' }
};

const ROUTES = ['101', '102', '103', 'A1', 'B2', 'C3', 'Express', 'Local'];

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function generateBusPosition(center, spreadKm = 10) {
  // Random position within spreadKm of center
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * spreadKm; // km
  
  // Convert to lat/lng offset
  const latOffset = (distance * Math.cos(angle)) / 111.32;
  const lngOffset = (distance * Math.sin(angle)) / (111.32 * Math.cos(center.lat * Math.PI / 180));
  
  return {
    lat: center.lat + latOffset,
    lng: center.lng + lngOffset
  };
}

async function seedBuses(count = 100, city = 'nyc') {
  const center = CITIES[city] || CITIES.nyc;
  
  console.log(`[SEED] Creating ${count} buses in ${center.name}...`);
  
  const buses = [];
  
  for (let i = 0; i < count; i++) {
    const pos = generateBusPosition(center, 15); // Spread 15km
    
    buses.push({
      busId: `BUS_${city.toUpperCase()}_${String(i + 1).padStart(3, '0')}`,
      location: {
        type: 'Point',
        coordinates: [pos.lng, pos.lat]
      },
      route: ROUTES[Math.floor(Math.random() * ROUTES.length)],
      routeId: `R${Math.floor(Math.random() * 20) + 1}`,
      destination: ['Downtown', 'Airport', 'Station', 'Mall'][Math.floor(Math.random() * 4)],
      speed: randomInRange(0, 15), // 0-15 m/s
      heading: randomInRange(0, 360),
      capacity: Math.floor(randomInRange(30, 80)),
      occupancy: Math.floor(randomInRange(0, 60)),
      status: 'active',
      lastUpdate: new Date(Date.now() - Math.floor(randomInRange(0, 300000))) // 0-5 min ago
    });
  }
  
  try {
    // Clear existing
    await Bus.deleteMany({});
    console.log('[SEED] Cleared existing buses');
    
    // Insert new
    await Bus.insertMany(buses);
    console.log(`[SEED] Created ${buses.length} buses`);
    
    // Verify geospatial index
    const indexes = await Bus.collection.getIndexes();
    console.log('[SEED] Database indexes:', Object.keys(indexes));
    
  } catch (error) {
    console.error('[SEED] Error:', error);
    process.exit(1);
  }
}

async function simulateMovement() {
  console.log('[SEED] Starting movement simulation...');
  
  setInterval(async () => {
    try {
      const buses = await Bus.find({ status: 'active' }).limit(50);
      
      for (const bus of buses) {
        const speed = bus.speed || 10; // m/s
        const heading = (bus.heading || 0) * Math.PI / 180;
        
        // Move 1 second worth of distance
        const moveDistance = speed; // meters
        const latOffset = (moveDistance * Math.cos(heading)) / 111320;
        const lngOffset = (moveDistance * Math.sin(heading)) / (111320 * Math.cos(bus.location.coordinates[1] * Math.PI / 180));
        
        const newLat = bus.location.coordinates[1] + latOffset;
        const newLng = bus.location.coordinates[0] + lngOffset;
        
        // Slight direction change
        const newHeading = (bus.heading + randomInRange(-10, 10) + 360) % 360;
        
        await Bus.updateOne(
          { _id: bus._id },
          {
            $set: {
              'location.coordinates': [newLng, newLat],
              heading: newHeading,
              speed: randomInRange(5, 15),
              lastUpdate: new Date()
            }
          }
        );
      }
      
      console.log(`[SEED] Updated ${buses.length} bus positions`);
      
    } catch (error) {
      console.error('[SEED] Movement error:', error);
    }
  }, 5000); // Update every 5 seconds
}

// Main
async function main() {
  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/bus_tracker';
  
  await mongoose.connect(mongoUri);
  console.log('[SEED] Connected to MongoDB');
  
  // Parse args
  const count = parseInt(process.argv[2]) || 100;
  const city = process.argv[3] || 'nyc';
  const shouldSimulate = process.argv.includes('--simulate');
  
  // Seed data
  await seedBuses(count, city);
  
  // Start simulation if requested
  if (shouldSimulate) {
    simulateMovement();
    console.log('[SEED] Movement simulation active (Ctrl+C to stop)');
  } else {
    console.log('[SEED] Done. Use --simulate to enable movement.');
    process.exit(0);
  }
}

main().catch(console.error);
