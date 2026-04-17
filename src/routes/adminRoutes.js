const express = require("express");
const multer = require("multer");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const {
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
} = require("../controllers/adminController");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/dashboard", requireAuth, requireRole("admin"), (req, res) => {
  return res.status(200).json({
    message: "Admin dashboard endpoint authorized",
    role: req.user.role,
    userId: req.user.id,
  });
});

router.post("/drivers", createDriver);
router.get("/drivers", listDrivers);
router.put("/drivers/:id", updateDriver);
router.delete("/drivers/:id", deleteDriver);

router.post("/buses", createBus);
router.get("/buses", listBuses);
router.put("/buses/:id", updateBus);
router.delete("/buses/:id", deleteBus);

router.post("/routes", createRoute);
router.get("/routes", listRoutes);
router.put("/routes/:id", updateRoute);
router.delete("/routes/:id", deleteRoute);
router.post("/upload-schedule", upload.single("file"), uploadSchedule);
router.get("/routes/:routeId/schedule", getRouteSchedule);

module.exports = router;
