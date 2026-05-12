path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

marker = '    console.log("[DENSIFIED ROUTE]", { originalCount: rawRouteCoords.length, denseCount: normalizedRouteCoords.length });\n\n    // Build normalized stops'
replacement = '    console.log("[DENSIFIED ROUTE]", { originalCount: rawRouteCoords.length, denseCount: normalizedRouteCoords.length });\n\n    // Require minimum dense coordinates for reliable snapping\n    if (normalizedRouteCoords.length < 20) {\n      console.log("[PROGRESSION EARLY RETURN]", "INSUFFICIENT_DENSE_COORDS", { denseCount: normalizedRouteCoords.length });\n      return createFallbackProgression(busId, gpsConfidence, accuracy);\n    }\n\n    // Build normalized stops'

if marker in content:
    content = content.replace(marker, replacement)
    print('Added dense coords check')
else:
    print('WARNING: Could not find marker')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
