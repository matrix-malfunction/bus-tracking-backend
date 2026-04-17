const mongoose = require("mongoose");

let isConnected = false;
let listenersAttached = false;

function getMongoHostHint(mongodbUri) {
  return mongodbUri
    .replace(/^mongodb(\+srv)?:\/\//, "")
    .split("@")
    .pop()
    .split("/")[0];
}

async function connectDB(mongodbUri) {
  if (isConnected) {
    return mongoose.connection;
  }

  if (!mongodbUri || !mongodbUri.trim()) {
    throw new Error("MONGO_URI is missing");
  }

  if (!listenersAttached) {
    mongoose.connection.on("error", (error) => {
      console.error("MongoDB connection error:", error.message);
    });

    mongoose.connection.on("disconnected", () => {
      isConnected = false;
      console.warn("MongoDB disconnected");
    });

    listenersAttached = true;
  }

  console.log(`Connecting to MongoDB (${getMongoHostHint(mongodbUri)})...`);
  await mongoose.connect(mongodbUri);

  console.log("MongoDB Connected");
  isConnected = true;
  return mongoose.connection;
}

module.exports = {
  connectDB,
};
