path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old = '    // Store updated progression\n    setBusProgression(busId, progression);\n\n    return progression;'
new = '    // Store updated progression\n    setBusProgression(busId, progression);\n\n    console.log("[PROGRESSION RETURN]", {\n      busId,\n      currentStopIndex: progression.currentStopIndex,\n      currentStopName: progression.currentStopName,\n      nextStopIndex: progression.nextStopIndex,\n      nextStopName: progression.nextStopName,\n      etaMinutes: progression.etaMinutes,\n      snappedLat: progression.snappedLat,\n      snappedLng: progression.snappedLng,\n      isSnapped: progression.isSnapped,\n    });\n\n    return progression;'

if old in content:
    content = content.replace(old, new)
    print('Added progression return log')
else:
    print('WARNING: Could not find marker in progressionEngine')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

# Now add EMIT CHECK log to locationController
path2 = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path2, 'r', encoding='utf-8') as f:
    content2 = f.read()

old2 = '            // Clean undefined values for JSON safety\n      const safeEmit = JSON.parse(JSON.stringify(emitPayload));\n      io.emit("BUS_LOCATION_UPDATE", safeEmit);'
new2 = '            // Clean undefined values for JSON safety\n      const safeEmit = JSON.parse(JSON.stringify(emitPayload));\n      console.log("[EMIT CHECK]", {\n        busId: safeEmit.busId,\n        currentStopName: safeEmit.currentStopName,\n        nextStopName: safeEmit.nextStopName,\n        nextStopEtaMinutes: safeEmit.nextStopEtaMinutes,\n        currentStopIndex: safeEmit.currentStopIndex,\n        snappedLat: safeEmit.snappedLat,\n        isSnapped: safeEmit.isSnapped,\n      });\n      io.emit("BUS_LOCATION_UPDATE", safeEmit);'

if old2 in content2:
    content2 = content2.replace(old2, new2)
    print('Added EMIT CHECK log to locationController')
else:
    print('WARNING: Could not find marker in locationController')

with open(path2, 'w', encoding='utf-8') as f:
    f.write(content2)

print('Done')
