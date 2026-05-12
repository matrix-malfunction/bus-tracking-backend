path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Replace the hysteresis section (step 4) in the route-polyline block
# Find the old block from "// 4. Hysteresis" through the safety clamps
old_block = """      // 4. Hysteresis: only advance stop if within 40m of target
      const previousState = getTrackingState(busId);
      const previousCurrentIndex = Number.isFinite(previousState?.routeProgressIndex)
        ? previousState.routeProgressIndex
        : -1;

      let currentStopIndex;
      let nextStopIndex;

      if (previousCurrentIndex === -1) {
        // First run — use polyline position directly
        currentStopIndex = rawNextStopIndex > 0 ? rawNextStopIndex - 1 : 0;
        nextStopIndex = rawNextStopIndex;
      } else {
        // Candidate is one stop ahead of previous current
        const candidateNext = previousCurrentIndex + 1;
        const candidateNextStop = demoStops[candidateNext];

        if (candidateNextStop) {
          const distToCandidate = distanceMeters(busLat, busLng, candidateNextStop.lat, candidateNextStop.lng);
          if (distToCandidate < 40) {
            // Close enough to advance
            currentStopIndex = candidateNext;
            nextStopIndex = Math.min(candidateNext + 1, demoStops.length - 1);
          } else {
            // Stay at previous current, next remains candidate
            currentStopIndex = previousCurrentIndex;
            nextStopIndex = candidateNext;
          }
        } else {
          // At or past end of route
          currentStopIndex = previousCurrentIndex;
          nextStopIndex = previousCurrentIndex;
        }
      }

      // Safety clamps
      if (currentStopIndex < 0) currentStopIndex = 0;
      if (currentStopIndex >= demoStops.length) currentStopIndex = demoStops.length - 1;
      if (nextStopIndex < currentStopIndex) nextStopIndex = currentStopIndex;
      if (nextStopIndex >= demoStops.length) nextStopIndex = demoStops.length - 1;"""

new_block = """      // 4. GPS-authoritative stop determination
      // Compute raw current/next from nearest route coordinate
      let rawCurrentStopIndex = -1;
      let rawNextStopIndex = -1;
      for (let i = 0; i < demoStops.length; i++) {
        if (stopCoordIndices[i] <= nearestCoordIndex) {
          rawCurrentStopIndex = i;
        }
        if (stopCoordIndices[i] > nearestCoordIndex && rawNextStopIndex === -1) {
          rawNextStopIndex = i;
        }
      }
      if (rawCurrentStopIndex < 0) rawCurrentStopIndex = 0;
      if (rawNextStopIndex < 0) rawNextStopIndex = Math.min(rawCurrentStopIndex + 1, demoStops.length - 1);

      // Forward-only hysteresis: use previous progression to prevent backward GPS jitter
      const prevProgression = getBusProgression(busId);
      const previousCurrentIndex = Number.isFinite(prevProgression?.currentStopIndex)
        ? prevProgression.currentStopIndex
        : -1;

      let currentStopIndex = rawCurrentStopIndex;
      let nextStopIndex = rawNextStopIndex;

      if (previousCurrentIndex >= 0) {
        if (rawCurrentStopIndex < previousCurrentIndex) {
          // GPS jitter caused backward jump — hold previous stop
          currentStopIndex = previousCurrentIndex;
          nextStopIndex = Math.min(previousCurrentIndex + 1, demoStops.length - 1);
        }
      }

      // Safety clamps
      if (currentStopIndex < 0) currentStopIndex = 0;
      if (currentStopIndex >= demoStops.length) currentStopIndex = demoStops.length - 1;
      if (nextStopIndex <= currentStopIndex) nextStopIndex = Math.min(currentStopIndex + 1, demoStops.length - 1);
      if (nextStopIndex >= demoStops.length) nextStopIndex = demoStops.length - 1;"""

content = content.replace(old_block, new_block, 1)

# 2. Replace ETA computation: distance along route from bus to next stop (not straight-line)
old_eta = """      const nextDistance = distanceMeters(busLat, busLng, nextStop.lat, nextStop.lng);
      const fallbackSpeedKmh = speedMps * 3.6;

      const prevTrackingState = getTrackingState(busId);
      const rawDerivedSpeed = prevTrackingState?.derivedSpeed ?? 0;
      const effectiveSpeed = rawDerivedSpeed > 5
        ? Math.round(rawDerivedSpeed)
        : Math.round(fallbackSpeedKmh ?? 35);
      const etaSpeedKmh = Math.max(15, effectiveSpeed);
      const etaMinutes = Math.max(1, Math.round(nextDistance / ((etaSpeedKmh * 1000) / 60)));"""

new_eta = """      // ETA: distance along route from current bus position to next stop
      let nextDistanceAlongRoute = 0;
      for (let i = nearestCoordIndex; i < stopCoordIndices[nextStopIndex] && i < normalizedRouteCoords.length - 1; i++) {
        nextDistanceAlongRoute += distanceMeters(
          normalizedRouteCoords[i].lat, normalizedRouteCoords[i].lng,
          normalizedRouteCoords[i + 1].lat, normalizedRouteCoords[i + 1].lng
        );
      }
      // Add straight-line from bus to nearest coord (small correction)
      nextDistanceAlongRoute += distanceMeters(busLat, busLng, normalizedRouteCoords[nearestCoordIndex].lat, normalizedRouteCoords[nearestCoordIndex].lng);

      const fallbackSpeedKmh = speedMps * 3.6;
      const prevTrackingState = getTrackingState(busId);
      const rawDerivedSpeed = prevTrackingState?.derivedSpeed ?? 0;
      const effectiveSpeed = rawDerivedSpeed > 5
        ? Math.round(rawDerivedSpeed)
        : Math.round(fallbackSpeedKmh ?? 35);
      const etaSpeedKmh = Math.max(15, effectiveSpeed);
      const etaMinutes = nextDistanceAlongRoute > 50
        ? Math.max(1, Math.round(nextDistanceAlongRoute / ((etaSpeedKmh * 1000) / 60)))
        : 0;"""

content = content.replace(old_eta, new_eta, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('progressionEngine updated')
