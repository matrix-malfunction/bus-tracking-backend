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
        snappedLat: sanitizeNumber(progression.snappedLat) ?? sanitizeNumber(progression.lastProjectedPoint?.lat) ?? null,
        snappedLng: sanitizeNumber(progression.snappedLng) ?? sanitizeNumber(progression.lastProjectedPoint?.lng) ?? null,
        distanceFromRoute: sanitizeNumber(progression.distanceFromRoute) ?? null,
        isSnapped: progression.isSnapped ?? !!progression.lastProjectedPoint,
      }),'''

new = '''      currentStopId: progression?.currentStopId ?? existingBus.currentStopId ?? null,
      currentStopName: progression?.currentStopName ?? existingBus.currentStopName ?? null,
      nextStopId: progression?.nextStopId ?? existingBus.nextStopId ?? null,
      nextStopName: progression?.nextStopName ?? existingBus.nextStopName ?? null,
      nextStopEtaMinutes: progression?.etaMinutes ?? existingBus.nextStopEtaMinutes ?? null,
      currentStopIndex: progression?.currentStopIndex ?? existingBus.currentStopIndex ?? null,
      routeProgressIndex: progression?.currentStopIndex ?? existingBus.routeProgressIndex ?? null,
      remainingDistanceMeters: progression?.remainingDistanceMeters ?? existingBus.remainingDistanceMeters ?? null,
      passedStopIds: progression?.passedStopIds ?? existingBus.passedStopIds ?? [],
      snappedLat: sanitizeNumber(progression?.snappedLat) ?? sanitizeNumber(progression?.lastProjectedPoint?.lat) ?? existingBus.snappedLat ?? null,
      snappedLng: sanitizeNumber(progression?.snappedLng) ?? sanitizeNumber(progression?.lastProjectedPoint?.lng) ?? existingBus.snappedLng ?? null,
      distanceFromRoute: sanitizeNumber(progression?.distanceFromRoute) ?? existingBus.distanceFromRoute ?? null,
      isSnapped: progression?.isSnapped ?? !!progression?.lastProjectedPoint ?? existingBus.isSnapped ?? false,'''

if old in content:
    content = content.replace(old, new)
    print('Replaced trackingState.set progression block')
else:
    print('WARNING: Could not find exact string, trying line-based replacement')
    # Fallback: find lines 873-887 and replace
    lines = content.splitlines(keepends=True)
    start_idx = None
    end_idx = None
    for i, line in enumerate(lines):
        if '...(progression && {' in line:
            start_idx = i
        if start_idx is not None and '}),' in line and 'isSnapped' in lines[i-1]:
            end_idx = i
            break
    if start_idx is not None and end_idx is not None:
        new_lines = lines[:start_idx] + [
            '      currentStopId: progression?.currentStopId ?? existingBus.currentStopId ?? null,\n',
            '      currentStopName: progression?.currentStopName ?? existingBus.currentStopName ?? null,\n',
            '      nextStopId: progression?.nextStopId ?? existingBus.nextStopId ?? null,\n',
            '      nextStopName: progression?.nextStopName ?? existingBus.nextStopName ?? null,\n',
            '      nextStopEtaMinutes: progression?.etaMinutes ?? existingBus.nextStopEtaMinutes ?? null,\n',
            '      currentStopIndex: progression?.currentStopIndex ?? existingBus.currentStopIndex ?? null,\n',
            '      routeProgressIndex: progression?.currentStopIndex ?? existingBus.routeProgressIndex ?? null,\n',
            '      remainingDistanceMeters: progression?.remainingDistanceMeters ?? existingBus.remainingDistanceMeters ?? null,\n',
            '      passedStopIds: progression?.passedStopIds ?? existingBus.passedStopIds ?? [],\n',
            '      snappedLat: sanitizeNumber(progression?.snappedLat) ?? sanitizeNumber(progression?.lastProjectedPoint?.lat) ?? existingBus.snappedLat ?? null,\n',
            '      snappedLng: sanitizeNumber(progression?.snappedLng) ?? sanitizeNumber(progression?.lastProjectedPoint?.lng) ?? existingBus.snappedLng ?? null,\n',
            '      distanceFromRoute: sanitizeNumber(progression?.distanceFromRoute) ?? existingBus.distanceFromRoute ?? null,\n',
            '      isSnapped: progression?.isSnapped ?? !!progression?.lastProjectedPoint ?? existingBus.isSnapped ?? false,\n',
        ] + lines[end_idx+1:]
        content = ''.join(new_lines)
        print('Line-based replacement succeeded')
    else:
        print(f'Line-based replacement failed: start={start_idx}, end={end_idx}')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
