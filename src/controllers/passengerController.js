const Location = require("../models/Location");

async function getNearbyBuses(req, res) {
  try {
    const { lat, lng, radiusKm = 2 } = req.query;

    const latitude = Number(lat);
    const longitude = Number(lng);
    const radiusMeters = Number(radiusKm) * 1000;

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return res.status(400).json({ message: "lat and lng query params are required" });
    }

    const buses = await Location.find({
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [longitude, latitude],
          },
          $maxDistance: radiusMeters,
        },
      },
    })
      .select("busId lat lng speed source updatedAt -_id")
      .lean();

    return res.status(200).json({
      count: buses.length,
      buses,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch nearby buses" });
  }
}

module.exports = {
  getNearbyBuses,
};
