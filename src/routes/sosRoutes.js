const express = require("express");
const { triggerSos } = require("../controllers/driverFeatureController");

const router = express.Router();

router.post("/", triggerSos);

module.exports = router;
