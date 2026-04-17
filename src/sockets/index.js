function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    socket.emit("connected", {
      message: "Socket connected",
      socketId: socket.id,
    });
  });
}

module.exports = {
  registerSocketHandlers,
};
