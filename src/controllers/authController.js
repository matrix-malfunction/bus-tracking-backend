const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const env = require("../config/env");

function sanitizeUser(user) {
  return {
    id: user._id,
    name: user.name,
    role: user.role,
    email: user.email,
  };
}

async function register(req, res) {
  try {
    const { name, role, email, password } = req.body;

    if (!name || !role || !email || !password) {
      return res.status(400).json({ message: "name, role, email, and password are required" });
    }

    if (!["admin", "driver", "passenger"].includes(role)) {
      return res.status(400).json({ message: "role must be admin, driver, or passenger" });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      role,
      email: email.toLowerCase(),
      password: hashedPassword,
    });

    return res.status(201).json({
      message: "User created",
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to register user" });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
      },
      env.jwtSecret,
      { expiresIn: "1d" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to login" });
  }
}

module.exports = {
  register,
  login,
};
