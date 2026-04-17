const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing or invalid Authorization header" });
    }

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Authenticated user:", req.user);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ message: "Forbidden: insufficient role permissions" });
    }
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
