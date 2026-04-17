const mongoose = require("mongoose");

const stopSchema = new mongoose.Schema({
  name: String,
  lat: Number,
  lng: Number,
});

const routeSchema = new mongoose.Schema({
  routeName: String,
  stops: [stopSchema],
});

module.exports = mongoose.model("Route", routeSchema);
