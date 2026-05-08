const { getBusStops } = require('../services/overpassService');

async function emitBusStops(socket) {
  try {
    const stops = await getBusStops();
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
    
    // Emit bus stops on connection
    emitBusStops(socket);
  });
}

module.exports = {
  registerSocketHandlers,
};
