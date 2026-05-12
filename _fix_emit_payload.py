path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old = '''          // Include progression fields for live stop display (from progression engine)
          ...(progression && {
            snappedLat: sanitizeNumber(progression.snappedLat) ?? sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
            snappedLng: sanitizeNumber(progression.snappedLng) ?? sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
            isSnapped: progression.isSnapped ?? false,
            distanceFromRoute: sanitizeNumber(progression.distanceFromRoute) ?? null,
            currentStopId: progression.currentStopId ?? null,
            currentStopName: progression.currentStopName ?? null,
            nextStopId: progression.nextStopId ?? null,
            nextStopName: progression.nextStopName ?? null,
            passedStopIds: progression.passedStopIds ?? [],
            nextStopEtaMinutes: sanitizeNumber(progression.etaMinutes) ?? null,
            remainingDistanceMeters: sanitizeNumber(progression.remainingDistanceMeters) ?? null,
            routeProgressIndex: progression.currentStopIndex ?? null,
            remainingDistanceKm: sanitizeNumber(progression.remainingDistanceKm) ?? null,
            progressPercent: sanitizeNumber(progression.progressPercent) ?? 0,
            avgSpeedKmh: sanitizeNumber(progression.avgSpeedKmh) ?? 0,
            derivedSpeed: sanitizeNumber(progression.derivedSpeed) ?? 0,
            occupancy: req.body?.occupancy ?? existingBus.occupancy ?? "UNKNOWN",
            capacity: Number.isFinite(progression.capacity) ? progression.capacity : null,
            gpsConfidence: progression.gpsConfidence ?? "UNKNOWN",
            gpsAccuracy: sanitizeNumber(progression.gpsAccuracy) ?? null
          })'''

new = '''          // Include progression fields for live stop display (from progression engine)
          snappedLat: sanitizeNumber(progression?.snappedLat) ?? sanitizeNumber(progression?.lastProjectedPoint?.lat) ?? existingBus.snappedLat ?? null,
          snappedLng: sanitizeNumber(progression?.snappedLng) ?? sanitizeNumber(progression?.lastProjectedPoint?.lng) ?? existingBus.snappedLng ?? null,
          isSnapped: progression?.isSnapped ?? existingBus.isSnapped ?? false,
          distanceFromRoute: sanitizeNumber(progression?.distanceFromRoute) ?? existingBus.distanceFromRoute ?? null,
          currentStopId: progression?.currentStopId ?? existingBus.currentStopId ?? null,
          currentStopName: progression?.currentStopName ?? existingBus.currentStopName ?? null,
          nextStopId: progression?.nextStopId ?? existingBus.nextStopId ?? null,
          nextStopName: progression?.nextStopName ?? existingBus.nextStopName ?? null,
          passedStopIds: progression?.passedStopIds ?? existingBus.passedStopIds ?? [],
          nextStopEtaMinutes: sanitizeNumber(progression?.etaMinutes) ?? existingBus.nextStopEtaMinutes ?? null,
          remainingDistanceMeters: sanitizeNumber(progression?.remainingDistanceMeters) ?? existingBus.remainingDistanceMeters ?? null,
          routeProgressIndex: progression?.currentStopIndex ?? existingBus.routeProgressIndex ?? null,
          remainingDistanceKm: sanitizeNumber(progression?.remainingDistanceKm) ?? existingBus.remainingDistanceKm ?? null,
          progressPercent: sanitizeNumber(progression?.progressPercent) ?? existingBus.progressPercent ?? 0,
          avgSpeedKmh: sanitizeNumber(progression?.avgSpeedKmh) ?? existingBus.avgSpeedKmh ?? 0,
          derivedSpeed: sanitizeNumber(progression?.derivedSpeed) ?? existingBus.derivedSpeed ?? 0,
          occupancy: req.body?.occupancy ?? existingBus.occupancy ?? "UNKNOWN",
          capacity: Number.isFinite(progression?.capacity) ? progression.capacity : (existingBus.capacity ?? null),
          gpsConfidence: progression?.gpsConfidence ?? existingBus.gpsConfidence ?? "UNKNOWN",
          gpsAccuracy: sanitizeNumber(progression?.gpsAccuracy) ?? existingBus.gpsAccuracy ?? null'''

if old in content:
    content = content.replace(old, new)
    print('Replaced emit payload progression block')
else:
    print('WARNING: Could not find emit payload block')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
