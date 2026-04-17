const express = require("express");

const router = express.Router();
const { loginPassenger } = require("../controllers/passengerAuthController");

router.post("/login", loginPassenger);

module.exports = router;
