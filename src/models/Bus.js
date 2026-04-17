const mongoose = require("mongoose");

const busSchema = new mongoose.Schema(
  {
    busId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bus", busSchema);
