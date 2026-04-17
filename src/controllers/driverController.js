const mongoose = require("mongoose");
const Bus = require("../models/Bus");
const Location = require("../models/Location");

async function setRoute(req, res) {
  try {
    const busId = String(req.body?.busId || "").trim();
    const routeId = String(req.body?.routeId || "").trim();

    if (!busId || !routeId) {
      return res.status(400).json({ message: "busId and routeId are required" });
    }

    if (!mongoose.Types.ObjectId.isValid(routeId)) {
      return res.status(400).json({ message: "routeId must be a valid ObjectId" });
    }

    const bus = await Bus.findOneAndUpdate(
      { busId },
      { $set: { routeId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const mirroredLocation = await Location.findOneAndUpdate(
      { busId },
      { $set: { routeId } },
      { new: true }
    ).lean();

    return res.status(200).json({
      message: "Route assigned successfully",
      busId: bus.busId,
      routeId: String(bus.routeId),
      mirroredToLocation: Boolean(mirroredLocation),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to set route for bus" });
  }
}

module.exports = {
  setRoute,
};
