path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old = '''      ...(progression && {
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
      }),'''

new = '''      ...(progression && {
        currentStopId: progression.currentStopId ?? null,
        currentStopName: progression.currentStopName ?? null,
        nextStopId: progression.nextStopId ?? null,
        nextStopName: progression.nextStopName ?? null,
        nextStopEtaMinutes: progression.etaMinutes ?? null,
        currentStopIndex: progression.currentStopIndex ?? null,
        routeProgressIndex: progression.currentStopIndex ?? null,
        remainingDistanceMeters: progression.remainingDistanceMeters ?? null,
        passedStopIds: progression.passedStopIds ?? [],
        snappedLat: sanitizeNumber(progression.snappedLat) ?? sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
        snappedLng: sanitizeNumber(progression.snappedLng) ?? sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
        distanceFromRoute: sanitizeNumber(progression.distanceFromRoute) ?? null,
        isSnapped: progression.isSnapped ?? !!progression.lastProjectedPoint,
      }),'''

if old in content:
    content = content.replace(old, new)
    print('Fixed tracking state update')
else:
    print('WARNING: Could not find tracking state block')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
