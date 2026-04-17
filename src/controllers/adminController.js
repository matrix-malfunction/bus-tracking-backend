const bcrypt = require("bcryptjs");
const xlsx = require("xlsx");
const User = require("../models/User");
const Bus = require("../models/Bus");
const Route = require("../models/Route");
const Stop = require("../models/Stop");
const Schedule = require("../models/Schedule");

async function createDriver(req, res) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, password are required" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const driver = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      role: "driver",
    });

    return res.status(201).json({
      message: "Driver created",
      driver: {
        id: driver._id,
        name: driver.name,
        email: driver.email,
        role: driver.role,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create driver" });
  }
}

async function listDrivers(req, res) {
  try {
    const drivers = await User.find({ role: "driver" }).select("name email role").lean();
    return res.status(200).json({ count: drivers.length, drivers });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch drivers" });
  }
}

async function updateDriver(req, res) {
  try {
    const { id } = req.params;
    const { name, email, password } = req.body;

    const driver = await User.findOne({ _id: id, role: "driver" });
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    if (name) driver.name = name;
    if (email) driver.email = email.toLowerCase();
    if (password) driver.password = await bcrypt.hash(password, 10);
    await driver.save();

    return res.status(200).json({
      message: "Driver updated",
      driver: { id: driver._id, name: driver.name, email: driver.email, role: driver.role },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update driver" });
  }
}

async function deleteDriver(req, res) {
  try {
    const { id } = req.params;
    const deleted = await User.findOneAndDelete({ _id: id, role: "driver" });
    if (!deleted) {
      return res.status(404).json({ message: "Driver not found" });
    }
    return res.status(200).json({ message: "Driver deleted" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete driver" });
  }
}

async function createBus(req, res) {
  try {
    const { busId, routeId = null } = req.body;
    if (!busId) {
      return res.status(400).json({ message: "busId is required" });
    }
    const bus = await Bus.create({ busId, routeId });
    return res.status(201).json({ message: "Bus created", bus });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create bus" });
  }
}

async function listBuses(req, res) {
  try {
    const buses = await Bus.find().populate("routeId", "name").lean();
    return res.status(200).json({ count: buses.length, buses });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch buses" });
  }
}

async function updateBus(req, res) {
  try {
    const { id } = req.params;
    const { busId, routeId } = req.body;
    const bus = await Bus.findByIdAndUpdate(
      id,
      { $set: { ...(busId ? { busId } : {}), ...(routeId !== undefined ? { routeId } : {}) } },
      { new: true }
    );
    if (!bus) {
      return res.status(404).json({ message: "Bus not found" });
    }
    return res.status(200).json({ message: "Bus updated", bus });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update bus" });
  }
}

async function deleteBus(req, res) {
  try {
    const { id } = req.params;
    const deleted = await Bus.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Bus not found" });
    }
    return res.status(200).json({ message: "Bus deleted" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete bus" });
  }
}

async function createRoute(req, res) {
  try {
    const { name, stops = [], schedule = [] } = req.body;
    if (!name) {
      return res.status(400).json({ message: "name is required" });
    }
    const route = await Route.create({ name, stops, schedule });
    return res.status(201).json({ message: "Route created", route });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create route" });
  }
}

async function listRoutes(req, res) {
  try {
    const routes = await Route.find().lean();
    return res.status(200).json({ count: routes.length, routes });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch routes" });
  }
}

async function updateRoute(req, res) {
  try {
    const { id } = req.params;
    const { name, stops, schedule } = req.body;
    const route = await Route.findByIdAndUpdate(
      id,
      {
        $set: {
          ...(name ? { name } : {}),
          ...(stops ? { stops } : {}),
          ...(schedule ? { schedule } : {}),
        },
      },
      { new: true }
    );
    if (!route) {
      return res.status(404).json({ message: "Route not found" });
    }
    return res.status(200).json({ message: "Route updated", route });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update route" });
  }
}

async function deleteRoute(req, res) {
  try {
    const { id } = req.params;
    const deleted = await Route.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Route not found" });
    }
    return res.status(200).json({ message: "Route deleted" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete route" });
  }
}

async function uploadSchedule(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Excel file is required" });
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({ message: "Excel has no sheets" });
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows.length) {
      return res.status(400).json({ message: "Excel has no data rows" });
    }

    const routeName = String(req.body.routeName || "").trim() || firstSheetName;
    let route = null;
    if (req.body.routeId) {
      route = await Route.findById(req.body.routeId);
    }
    if (!route) {
      route = await Route.create({ name: routeName, stops: [], schedule: [] });
    }

    const stopDocs = [];
    const scheduleStops = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const stopName = String(
        row["Stop Name"] || row.stopName || row.stop || row.name || ""
      ).trim();
      const latitude = Number(row.Lat || row.lat || row.latitude);
      const longitude = Number(row.Lng || row.lng || row.longitude);
      const time = String(row.Time || row.time || "").trim();

      if (!stopName || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        continue;
      }

      const stop = await Stop.create({
        routeId: route._id,
        name: stopName,
        latitude,
        longitude,
        order: index,
      });

      stopDocs.push(stop);
      if (time) {
        scheduleStops.push({ stopId: stop._id, time });
      }
    }

    await Stop.deleteMany({ routeId: route._id, _id: { $nin: stopDocs.map((s) => s._id) } });

    await Schedule.findOneAndUpdate(
      { routeId: route._id },
      { $set: { routeId: route._id, stops: scheduleStops } },
      { upsert: true, new: true }
    );

    await Route.findByIdAndUpdate(route._id, {
      $set: {
        name: route.name,
        stops: stopDocs.map((stop) => ({
          name: stop.name,
          lat: stop.latitude,
          lng: stop.longitude,
        })),
        schedule: scheduleStops.map((entry) => {
          const stop = stopDocs.find((doc) => String(doc._id) === String(entry.stopId));
          return { stopName: stop?.name || "", time: entry.time };
        }),
      },
    });

    return res.status(200).json({
      message: "Schedule uploaded successfully",
      routeId: route._id,
      routeName: route.name,
      stopsCreated: stopDocs.length,
      scheduleEntries: scheduleStops.length,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to upload schedule" });
  }
}

async function getRouteSchedule(req, res) {
  try {
    const { routeId } = req.params;
    const route = await Route.findById(routeId).lean();
    if (!route) {
      return res.status(404).json({ message: "Route not found" });
    }

    const [stops, schedule] = await Promise.all([
      Stop.find({ routeId }).sort({ order: 1 }).lean(),
      Schedule.findOne({ routeId }).lean(),
    ]);

    const scheduleByStopId = new Map(
      (schedule?.stops || []).map((entry) => [String(entry.stopId), entry.time || ""])
    );

    return res.status(200).json({
      routeId: route._id,
      routeName: route.name,
      stops: stops.map((stop) => ({
        stopId: stop._id,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
        order: stop.order,
        time: scheduleByStopId.get(String(stop._id)) || "",
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch route schedule" });
  }
}

module.exports = {
  createDriver,
  listDrivers,
  updateDriver,
  deleteDriver,
  createBus,
  listBuses,
  updateBus,
  deleteBus,
  createRoute,
  listRoutes,
  updateRoute,
  deleteRoute,
  uploadSchedule,
  getRouteSchedule,
};
