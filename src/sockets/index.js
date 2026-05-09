const { getBusStops } = require('../services/overpassService');

async function emitBusStops(socket) {
  try {
    const stops = await getBusStops();
    console.log(`[Socket] emitBusStops: ${stops.length} stops`);
    
    // Log sample stops for verification
    const customStops = stops.filter(s => s.id && s.id.startsWith('custom_'));
    console.log(`[Socket] Custom stops count: ${customStops.length}`);
    console.log(`[Socket] Custom stops sample:`, customStops.slice(0, 3).map(s => s.id));
    
    socket.emit("INIT_BUS_STOPS", { stops });
    console.log(`[Socket] Emitted ${stops.length} bus stops to ${socket.id}`);
  } catch (error) {
    console.error('[Socket] Error emitting bus stops:', error.message);
  }
}

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    socket.emit("connected", {
      message: "Socket connected",
      socketId: socket.id,
    });
    
    // Emit bus stops on connection (for early clients)
    emitBusStops(socket);
    
    // Listen for explicit request from client (reliable delivery)
    socket.on("REQUEST_BUS_STOPS", async () => {
      console.log(`[Socket] REQUEST_BUS_STOPS received from ${socket.id}`);
      await emitBusStops(socket);
    });
  });
}

module.exports = {
  registerSocketHandlers,
};
