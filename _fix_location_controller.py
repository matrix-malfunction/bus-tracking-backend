import re

path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove the secondary route snapping section (lines ~675-731)
old_snap_section = '''    // === ROUTE SNAPPING (Corridor Locking) ===
    // Calculate snapped coordinates for professional AVL-style rendering
    // CRITICAL: This is an optional enhancement - tracking must continue even if snapping fails
    let snappedCoords = null;
    
    // EXECUTION TRACE: Track route lookup (routeInfo already hoisted above)
    console.log("[SNAP TRACE] busId:", busId, "routeInfo:", routeInfo);
    
    let routeData = null;
    if (routeInfo && routeInfo.routeId) {
      routeData = routes.find(r => r.id === routeInfo.routeId);
      console.log("[SNAP TRACE] Looking for routeId:", routeInfo.routeId, "found:", !!routeData);
    }

    // Normalize route coordinate access (handle both formats)
    const routeCoords =
      routeData?.routeCoords ||
      routeData?.coordinates ||
      null;

    console.log("[SNAP TRACE] coords source:", {
      hasRouteCoords: !!routeData?.routeCoords,
      hasCoordinates: !!routeData?.coordinates,
      coordsCount: Array.isArray(routeCoords) ? routeCoords.length : 0
    });

    if (routeCoords && routeCoords.length >= 2) {
      try {
        console.log("[SNAP TRACE] Invoking snapToRouteCorridor...");
        // Import snapToRouteCorridor from progressionEngine
        const { snapToRouteCorridor } = require("../utils/progressionEngine");
        snappedCoords = snapToRouteCorridor(numLat, numLng, routeCoords);

        console.log("[SNAP TRACE] snap result:", snappedCoords ? {
          hasSnappedLat: !!snappedCoords.snappedLat,
          hasSnappedLng: !!snappedCoords.snappedLng,
          distance: Math.round(snappedCoords.distanceFromRoute),
          isSnapped: snappedCoords.isSnapped
        } : null);

        if (snappedCoords) {
          console.log("[BACKEND] Route snapping:", {
            busId,
            snappedLat: snappedCoords.snappedLat,
            snappedLng: snappedCoords.snappedLng,
            distanceFromRoute: Math.round(snappedCoords.distanceFromRoute),
            isSoftSnap: snappedCoords.isSoftSnap ?? false
          });
        }
      } catch (error) {
        // CRITICAL: Never let snapping failures break the tracking pipeline
        console.error("[Route Snap] Failed for bus", busId, ":", error.message);
        snappedCoords = null;
      }
    } else {
      console.log("[SNAP TRACE] No valid routeCoords - skipping snapping");
    }

    // === SOCKET EMIT ==='''

new_snap_section = '    // === SOCKET EMIT ==='

if old_snap_section in content:
    content = content.replace(old_snap_section, new_snap_section)
    print('Removed secondary snap section')
else:
    print('WARNING: Could not find secondary snap section')

# 2. Remove snappedCoords spread from emit payload and routeCoords from routeInfo spread
old_emit_route = '''          ...(routeInfo && {
            routeId: routeInfo.routeId,
            routeName: routeInfo.routeName,
            routeColor: routeInfo.routeColor,
            direction: routeInfo.direction,
            tripId: routeInfo.tripId,
            routeCoords: routeInfo.routeCoords || routeCoords || []
          }),'''

new_emit_route = '''          ...(routeInfo && {
            routeId: routeInfo.routeId,
            routeName: routeInfo.routeName,
            routeColor: routeInfo.routeColor,
            direction: routeInfo.direction,
            tripId: routeInfo.tripId,
          }),'''

if old_emit_route in content:
    content = content.replace(old_emit_route, new_emit_route)
    print('Removed routeCoords from emit payload')
else:
    print('WARNING: Could not find routeInfo emit block')

# 3. Also remove the snappedCoords conditional spread from emit payload
old_snapped_spread = '''          // Snapped coordinates (if within route corridor)
          ...(snappedCoords && {
            snappedLat: sanitizeNumber(snappedCoords.snappedLat),
            snappedLng: sanitizeNumber(snappedCoords.snappedLng),
            isSnapped: true,
            distanceFromRoute: sanitizeNumber(snappedCoords.distanceFromRoute),
            isSoftSnap: snappedCoords.isSoftSnap ?? false
          }),'''

new_snapped_spread = ''

if old_snapped_spread in content:
    content = content.replace(old_snapped_spread, new_snapped_spread)
    print('Removed snappedCoords spread from emit')
else:
    print('WARNING: Could not find snappedCoords spread')

# 4. Update emit payload to use progression snapped data directly (progression already handles it)
# The progression spread already includes snappedLat/snappedLng/distanceFromRoute/isSnapped
# Make sure isSnapped uses progression.isSnapped properly
old_progression_snap = '''            snappedLat: sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
            snappedLng: sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
            isSnapped: progression.isSnapped ?? false,'''

new_progression_snap = '''            snappedLat: sanitizeNumber(progression.snappedLat) ?? sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
            snappedLng: sanitizeNumber(progression.snappedLng) ?? sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
            isSnapped: progression.isSnapped ?? false,'''

if old_progression_snap in content:
    content = content.replace(old_progression_snap, new_progression_snap)
    print('Updated progression snapped data to use new fields')
else:
    print('WARNING: Could not find progression snap block')

# 5. Densify coords in startTracking before storing
# Find the line where denseCoords is assigned and densify it
old_dense = '''      const denseCoords = rawPolyline.length >= 2 ? rawPolyline : stopPositionCoords;'''

new_dense = '''      let denseCoords = rawPolyline.length >= 2 ? rawPolyline : stopPositionCoords;
      // Densify sparse coordinates to ~15m spacing for accurate backend snapping
      if (denseCoords.length >= 2) {
        const { densifyRouteCoords } = require("../utils/progressionEngine");
        const normalized = denseCoords.map(c => {
          if (Array.isArray(c) && c.length >= 2) return { lat: Number(c[0]), lng: Number(c[1]) };
          if (c && typeof c === "object" && c.lat !== undefined) return { lat: Number(c.lat), lng: Number(c.lng) };
          return null;
        }).filter(Boolean);
        const densified = densifyRouteCoords(normalized);
        denseCoords = densified.map(c => [c.lat, c.lng]);
        console.log("[START TRACKING] Densified route coords:", { original: normalized.length, dense: denseCoords.length });
      }'''

if old_dense in content:
    content = content.replace(old_dense, new_dense)
    print('Densified coords in startTracking')
else:
    print('WARNING: Could not find denseCoords assignment in startTracking')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('locationController.js updated')
