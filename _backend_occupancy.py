path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add occupancy to startTracking destructuring
old1 = "    const { busId, lat, lng, routeId, routeName, routeColor, direction } = req.body;"
new1 = "    const { busId, lat, lng, routeId, routeName, routeColor, direction, occupancy } = req.body;"
content = content.replace(old1, new1, 1)

# 2. Add occupancy to startTracking consolidated trackingState
old2 = """      trackingState.set(busId, {
        ...consolidatedBase,
        routeCoords: routeData.routeCoords,
        stops: routeData.stops,
        passedStopIds: consolidatedBase.passedStopIds ?? [],
        currentStopIndex: 0,
        routeProgressIndex: 0,
        lastUpdate: Date.now(),
      });"""
new2 = """      trackingState.set(busId, {
        ...consolidatedBase,
        routeCoords: routeData.routeCoords,
        stops: routeData.stops,
        passedStopIds: consolidatedBase.passedStopIds ?? [],
        currentStopIndex: 0,
        routeProgressIndex: 0,
        occupancy: occupancy || consolidatedBase.occupancy || "UNKNOWN",
        lastUpdate: Date.now(),
      });"""
content = content.replace(old2, new2, 1)

# 3. Replace progression-based occupancy in emitPayload with driver-provided
old3 = """            occupancy: Number.isFinite(progression.occupancy) ? progression.occupancy : null,
            capacity: Number.isFinite(progression.capacity) ? progression.capacity : null,"""
new3 = """            occupancy: req.body?.occupancy ?? existingBus.occupancy ?? "UNKNOWN",
            capacity: Number.isFinite(progression.capacity) ? progression.capacity : null,"""
content = content.replace(old3, new3, 1)

# 4. Add occupancy to trackingState.set in updateLocation
old4 = """      ...(progression && {
        currentStopId: progression.currentStopId ?? null,
        currentStopName: progression.currentStopName ?? null,
        nextStopId: progression.nextStopId ?? null,
        nextStopName: progression.nextStopName ?? null,
        nextStopEtaMinutes: progression.etaMinutes ?? null,
        currentStopIndex: progression.currentStopIndex ?? null,
        routeProgressIndex: progression.currentStopIndex ?? null,
        remainingDistanceMeters: progression.remainingDistanceMeters ?? null,
        passedStopIds: progression.passedStopIds ?? [],
        isSnapped: !!progression.lastProjectedPoint,
      }),"""
new4 = """      ...(progression && {
        currentStopId: progression.currentStopId ?? null,
        currentStopName: progression.currentStopName ?? null,
        nextStopId: progression.nextStopId ?? null,
        nextStopName: progression.nextStopName ?? null,
        nextStopEtaMinutes: progression.etaMinutes ?? null,
        currentStopIndex: progression.currentStopIndex ?? null,
        routeProgressIndex: progression.currentStopIndex ?? null,
        remainingDistanceMeters: progression.remainingDistanceMeters ?? null,
        passedStopIds: progression.passedStopIds ?? [],
        isSnapped: !!progression.lastProjectedPoint,
      }),
      occupancy: req.body?.occupancy ?? existingBus.occupancy ?? "UNKNOWN","""
content = content.replace(old4, new4, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('backend occupancy done')
