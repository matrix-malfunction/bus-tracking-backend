const express = require('express');
const mongoose = require('mongoose');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const busRoutes = require('./api/routes/buses');
const { streamManager, setupChangeStream } = require('./utils/streaming');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow WebView to load maps
}));

app.use(cors({
  origin: ['http://localhost:19006', 'capacitor://localhost', 'ionic://localhost'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression for all responses
app.use(compression({
  level: 6, // Balance between CPU and compression
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many requests, please try again later' }
});

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30, // Stricter for heavy endpoints
  message: { error: 'Rate limit exceeded for this endpoint' }
});

// Body parsing
app.use(express.json({ limit: '10kb' }));

// Request logging (development)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// Routes
app.use('/api/buses', limiter, busRoutes);
app.use('/api/buses/stream', strictLimiter, busRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    streams: streamManager.getStats()
  });
});

// API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Bus Tracker API',
    version: '1.0.0',
    endpoints: {
      'GET /api/buses/nearby': {
        description: 'Get buses near a location',
        params: {
          lat: 'Latitude (required)',
          lng: 'Longitude (required)',
          radius: 'Search radius in meters (default: 5000)',
          limit: 'Max results (default: 50, max: 100)',
          fields: 'Comma-separated fields (optional)'
        },
        example: '/api/buses/nearby?lat=40.7128&lng=-74.0060&radius=5000&limit=50'
      },
      'GET /api/buses/bounds': {
        description: 'Get buses within bounding box',
        params: {
          north: 'North boundary (required)',
          south: 'South boundary (required)',
          east: 'East boundary (required)',
          west: 'West boundary (required)',
          zoom: 'Map zoom level (for clustering)',
          limit: 'Max results (default: 100)'
        },
        example: '/api/buses/bounds?north=40.8&south=40.6&east=-73.9&west=-74.1'
      },
      'GET /api/buses/stream': {
        description: 'Server-sent events for real-time updates',
        params: {
          lat: 'User latitude',
          lng: 'User longitude',
          radius: 'Subscription radius'
        },
        note: 'Returns text/event-stream'
      },
      'GET /api/buses/:id': {
        description: 'Get single bus details'
      }
    },
    optimizations: [
      'Geospatial queries with $near and $geoWithin',
      'Response compression (gzip)',
      'Minimal JSON field names',
      'Lean queries (no mongoose documents)',
      'Automatic clustering at low zoom',
      'Stale data filtering (>5 min ignored)'
    ]
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Connect to MongoDB and start server
async function startServer() {
  try {
    // MongoDB connection
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/bus_tracker';
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('[DB] Connected to MongoDB');

    // Setup change stream for real-time updates
    await setupChangeStream();

    // Start streaming manager
    streamManager.start(1000); // 1 second update frequency

    // Start server
    app.listen(PORT, () => {
      console.log(`[SERVER] Running on port ${PORT}`);
      console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
    });

  } catch (error) {
    console.error('[SERVER] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[SERVER] SIGTERM received, shutting down gracefully');
  
  streamManager.stop();
  
  await mongoose.connection.close();
  console.log('[DB] MongoDB connection closed');
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SERVER] SIGINT received, shutting down gracefully');
  
  streamManager.stop();
  
  await mongoose.connection.close();
  console.log('[DB] MongoDB connection closed');
  
  process.exit(0);
});

// Start
startServer();

module.exports = app;
