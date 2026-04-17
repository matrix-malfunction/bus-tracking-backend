const express = require("express");

const router = express.Router();
const { createEmergency } = require("../controllers/driverEmergencyController");

router.post("/create", createEmergency);

module.exports = router;
