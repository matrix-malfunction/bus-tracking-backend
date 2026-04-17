const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./models/User");
require("dotenv").config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  try {
    const hashed = await bcrypt.hash("123456", 10);

    await User.updateOne(
      { email: "driver@test.com" },
      { $set: { password: hashed } }
    );

    await User.updateOne(
      { email: "passenger@test.com" },
      { $set: { password: hashed } }
    );

    console.log("Passwords reset successful");
    process.exit(0);
  } catch (error) {
    console.error("Reset failed:", error);
    process.exit(1);
  }
});
