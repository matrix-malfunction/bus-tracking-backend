import re

path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add densifyRouteCoords function before computeBusProgression
densify_func = """
/**
 * Densify sparse route coordinates to ~15m spacing for accurate snapping
 */
function densifyRouteCoords(coords) {
  if (!coords || coords.length < 2) return coords || [];
  const dense = [coords[0]];
  for (let i = 0; i < coords.length - 1; i++) {
    const start = coords[i];
    const end = coords[i + 1];
    const segDist = distanceMeters(start.lat, start.lng, end.lat, end.lng);
    const steps = Math.max(3, Math.ceil(segDist / 15));
    for (let j = 1; j < steps; j++) {
      const t = j / steps;
      dense.push({
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
      });
    }
    dense.push(end);
  }
  return dense;
}

"""

# Insert densify function before computeBusProgression
marker = '/**\n * Main progression computation function\n'
if marker in content:
    content = content.replace(marker, densify_func + marker)
else:
    print('Could not find computeBusProgression marker')

# 2. Replace computeBusProgression function entirely
old_func_start = 'function computeBusProgression(busId, busLat, busLng, speedMps, route, accuracy) {\n  try {'
old_func_end = '  }\n}\n\n/**\n * Check if progression changed meaningfully'

new_func = '''function computeBusProgression(busId, busLat, busLng, speedMps, route, accuracy) {
  try {
    console.log("[ENGINE ENTRY]", {
      busId,
      hasStops: !!route?.stops?.length,
      stopsCount: route?.stops?.length,
      hasRouteCoords: !!(route?.routeCoords?.length || route?.coordinates?.length),
      routeCoordsCount: route?.routeCoords?.length || route?.coordinates?.length,
    });

    if (!Number.isFinite(busLat) || !Number.isFinite(busLng) || !route) {
      console.log("[PROGRESSION EARLY RETURN]", "INVALID_INPUTS");
      return createFallbackProgression(busId, null, null);
    }

    const gpsConfidence = getGpsConfidence(accuracy);

    // ROUTE HYDRATION: Normalize route coordinates ONCE
    const rawRouteCoords = route?.routeCoords || route?.coordinates || [];
    let normalizedRouteCoords = (Array.isArray(rawRouteCoords) ? rawRouteCoords : [])
      .map(toLatLng)
      .filter(Boolean);

    if (normalizedRouteCoords.length < 2) {
      console.log("[PROGRESSION EARLY RETURN]", "NO_ROUTE_COORDS");
      return createFallbackProgression(busId, gpsConfidence, accuracy);
    }

    // DENSIFY: interpolate to ~15m spacing for accurate snapping
    normalizedRouteCoords = densifyRouteCoords(normalizedRouteCoords);
    console.log("[DENSIFIED ROUTE]", { originalCount: rawRouteCoords.length, denseCount: normalizedRouteCoords.length });

    // Build normalized stops
    const rawStops = route?.stops || [];
    const demoStops = rawStops.map((stop) => {
      if (typeof stop === "string") {
        const coords = getStopCoordsById(stop);
        return coords ? { stopId: stop, name: getSafeStopName(stop), lat: coords.lat, lng: coords.lng } : null;
      }
      const lat = stop.lat ?? stop.latitude;
      const lng = stop.lng ?? stop.longitude;
      const stopId = stop.stopId || stop.id || stop._id || null;
      const name = stop.name || getSafeStopName(stop) || null;
      return typeof lat === "number" && typeof lng === "number" ? { stopId, name, lat, lng } : null;
    }).filter(Boolean);

    if (demoStops.length < 2) {
      console.log("[PROGRESSION EARLY RETURN]", "INSUFFICIENT_STOPS", { stopCount: demoStops.length });
      return createFallbackProgression(busId, gpsConfidence, accuracy);
    }

    // 1. Find nearest route coordinate index to bus
    let nearestCoordIndex = 0;
    let minCoordDist = Infinity;
    normalizedRouteCoords.forEach((coord, idx) => {
      const d = distanceMeters(busLat, busLng, coord.lat, coord.lng);
      if (d < minCoordDist) {
        minCoordDist = d;
        nearestCoordIndex = idx;
      }
    });

    const snappedLat = normalizedRouteCoords[nearestCoordIndex].lat;
    const snappedLng = normalizedRouteCoords[nearestCoordIndex].lng;
    const distanceFromRoute = minCoordDist;

    // 2. Map each stop to its nearest route coordinate index
    const stopCoordIndices = demoStops.map((stop) => {
      let bestIdx = 0;
      let bestDist = Infinity;
      normalizedRouteCoords.forEach((coord, idx) => {
        const d = distanceMeters(stop.lat, stop.lng, coord.lat, coord.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });
      return bestIdx;
    });

    // 3. Determine raw current/next stops from bus position on route
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

    // 4. Forward-only jitter protection
    const prevProgression = getBusProgression(busId);
    const previousCurrentIndex = Number.isFinite(prevProgression?.currentStopIndex)
      ? prevProgression.currentStopIndex
      : -1;

    let currentStopIndex = rawCurrentStopIndex;
    let nextStopIndex = rawNextStopIndex;

    if (previousCurrentIndex >= 0 && rawCurrentStopIndex < previousCurrentIndex) {
      currentStopIndex = previousCurrentIndex;
      nextStopIndex = Math.min(previousCurrentIndex + 1, demoStops.length - 1);
    }

    // Safety clamps
    if (currentStopIndex < 0) currentStopIndex = 0;
    if (currentStopIndex >= demoStops.length) currentStopIndex = demoStops.length - 1;
    if (nextStopIndex <= currentStopIndex) nextStopIndex = Math.min(currentStopIndex + 1, demoStops.length - 1);
    if (nextStopIndex >= demoStops.length) nextStopIndex = demoStops.length - 1;

    const currentStop = demoStops[currentStopIndex];
    const nextStop = demoStops[nextStopIndex];

    // 5. SPEED: GPS speed if available (> 5 km/h), otherwise derivedSpeed, with moving average
    const gpsSpeedKmh = (speedMps && speedMps > 0) ? speedMps * 3.6 : 0;
    const prevTrackingState = getTrackingState(busId);
    const derivedSpeed = prevTrackingState?.derivedSpeed ?? 0;

    let finalSpeedKmh = gpsSpeedKmh > 5 ? gpsSpeedKmh : (derivedSpeed > 5 ? derivedSpeed : 15);
    finalSpeedKmh = Math.min(finalSpeedKmh, 120); // Clamp to max reasonable speed

    // Add to rolling average and get smoothed speed
    addSpeedSample(busId, finalSpeedKmh);
    const rollingSpeedKmh = getRollingAverageSpeed(busId);

    // 6. ETA: distance along route from bus to next stop
    let nextDistanceAlongRoute = 0;
    for (let i = nearestCoordIndex; i < stopCoordIndices[nextStopIndex] && i < normalizedRouteCoords.length - 1; i++) {
      nextDistanceAlongRoute += distanceMeters(
        normalizedRouteCoords[i].lat, normalizedRouteCoords[i].lng,
        normalizedRouteCoords[i + 1].lat, normalizedRouteCoords[i + 1].lng
      );
    }
    // Add straight-line from bus to nearest coord
    nextDistanceAlongRoute += distanceMeters(busLat, busLng, snappedLat, snappedLng);

    const etaSpeedKmh = Math.max(15, rollingSpeedKmh);
    const etaMinutes = nextDistanceAlongRoute > 50
      ? Math.max(1, Math.round(nextDistanceAlongRoute / ((etaSpeedKmh * 1000) / 60)))
      : 0;

    // 7. Progress percent
    const routeProgressPercent = Math.round(
      (nearestCoordIndex / Math.max(1, normalizedRouteCoords.length - 1)) * 100
    );

    // passedStopIds
    const passedStopIds = [];
    for (let i = 0; i < currentStopIndex; i++) {
      if (demoStops[i]?.stopId) passedStopIds.push(demoStops[i].stopId);
    }

    console.log("[ROUTE-POLYLINE PROGRESSION]", {
      nearestCoordIndex,
      currentStopIndex,
      nextStopIndex,
      currentStop: currentStop?.name,
      nextStop: nextStop?.name,
      etaMinutes,
      routeProgressPercent,
      rollingSpeedKmh: Math.round(rollingSpeedKmh * 10) / 10,
    });

    const progression = {
      busId,
      isSnapped: true,
      nearestRouteIndex: nearestCoordIndex,
      snappedLat,
      snappedLng,
      distanceFromRoute: Math.round(distanceFromRoute),
      gpsConfidence,
      gpsAccuracy: safeNumber(accuracy) ?? null,
      tripId: route.tripId || null,
      routeId: route.routeId || null,
      currentStopIndex,
      routeProgressIndex: currentStopIndex,
      currentStopId: currentStop?.stopId ?? null,
      currentStopName: currentStop?.name ?? null,
      nextStopIndex,
      nextStopId: nextStop?.stopId ?? null,
      nextStopName: nextStop?.name ?? null,
      passedStopIds,
      remainingDistanceKm: 0,
      remainingDistanceMeters: Math.round(nextDistanceAlongRoute),
      progressPercent: routeProgressPercent,
      etaMinutes,
      avgSpeedKmh: Math.round(rollingSpeedKmh * 10) / 10,
      derivedSpeed: finalSpeedKmh,
      occupancy: Math.floor(25 + Math.random() * 35),
      capacity: 50,
      cumulativeDistance: 0,
      totalRouteLength: 0,
      lastProjectedPoint: { lat: snappedLat, lng: snappedLng },
      lastUpdate: Date.now(),
      jitterFiltered: false,
    };

    // Store updated progression
    setBusProgression(busId, progression);

    return progression;
  } catch (error) {
    console.error("[PROGRESSION] CRASH", {
      busId,
      error: error.message,
      stack: error.stack?.split('\\n')[0]
    });
    return createFallbackProgression(busId, gpsConfidence, accuracy);
  }
}
'''

# Find the old function and replace it
# Use regex to find from "function computeBusProgression" to the next "function hasProgressionChanged"
pattern = r'(function computeBusProgression\(busId, busLat, busLng, speedMps, route, accuracy\) \{.*?\n  \}\n\n)(/\*\*\n \* Check if progression changed meaningfully)'
match = re.search(pattern, content, re.DOTALL)
if match:
    content = content[:match.start()] + new_func + '\n\n/**\n * Check if progression changed meaningfully' + content[match.end():]
    print('Replaced computeBusProgression')
else:
    print('Could not find computeBusProgression function boundary, trying manual replacement')
    # Fallback: find the exact text span
    start_marker = '/**\n * Main progression computation function\n * Called during each BUS_LOCATION_UPDATE\n */\nfunction computeBusProgression'
    end_marker = '\n/**\n * Check if progression changed meaningfully (for emission throttling)\n */'
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)
    if start_idx != -1 and end_idx != -1:
        content = content[:start_idx] + new_func.rstrip() + content[end_idx:]
        print('Manual replacement succeeded')
    else:
        print(f'Manual replacement failed: start={start_idx}, end={end_idx}')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('progressionEngine.js updated')
