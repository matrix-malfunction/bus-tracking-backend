const express = require("express");

const router = express.Router();
const { createSos } = require("../controllers/passengerSosController");

router.post("/create", createSos);

module.exports = router;
