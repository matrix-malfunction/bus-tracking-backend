const express = require("express");
const router = express.Router();
const routes = require("../data/routes");

/**
 * GET /api/routes
 * Returns all available bus routes
 */
router.get("/", (req, res) => {
  try {
    // Return routes with essential fields (exclude detailed coordinates if needed)
    const simplifiedRoutes = routes.map(route => ({
      id: route.id,
      name: route.name,
      shortName: route.shortName,
      color: route.color,
      district: route.district,
      type: route.type,
      stopCount: route.stops?.length || 0,
    }));
    
    console.log(`[Routes API] Returning ${simplifiedRoutes.length} routes`);
    res.json({
      count: simplifiedRoutes.length,
      routes: simplifiedRoutes
    });
  } catch (error) {
    console.error("[Routes API] Error:", error.message);
    res.status(500).json({ error: "Failed to fetch routes" });
  }
});

/**
 * GET /api/routes/:id
 * Returns full route details including stops and coordinates
 */
router.get("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const route = routes.find(r => r.id === id);
    
    if (!route) {
      return res.status(404).json({ error: "Route not found" });
    }
    
    console.log(`[Routes API] Returning route: ${route.name}`);
    res.json({
      route: route
    });
  } catch (error) {
    console.error("[Routes API] Error:", error.message);
    res.status(500).json({ error: "Failed to fetch route" });
  }
});

module.exports = router;
