path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Full state emit after updateLocation
old1 = '''      const emitPayload = {
        ...fullState,
        latitude: fullState.lat ?? fullState.location?.latitude ?? null,
        longitude: fullState.lng ?? fullState.location?.longitude ?? null,
        timestamp: Date.now(),
        trackingActive: true,
      };'''

new1 = '''      const emitPayload = {
        ...fullState,
        latitude: fullState.lat ?? fullState.location?.latitude ?? null,
        longitude: fullState.lng ?? fullState.location?.longitude ?? null,
        timestamp: Date.now(),
        trackingActive: true,
      };
      delete emitPayload.routeCoords;'''

if old1 in content:
    content = content.replace(old1, new1)
    print('Fixed fullState emit 1')
else:
    print('WARNING: Could not find fullState emit 1')

# Fix 2: Full state emit in startTracking
old2 = '''        const emitPayload = {
          ...startState,
          latitude: numLat,
          longitude: numLng,
          timestamp: Date.now(),
          trackingActive: true,
        };'''

new2 = '''        const emitPayload = {
          ...startState,
          latitude: numLat,
          longitude: numLng,
          timestamp: Date.now(),
          trackingActive: true,
        };
        delete emitPayload.routeCoords;'''

if old2 in content:
    content = content.replace(old2, new2)
    print('Fixed startState emit 2')
else:
    print('WARNING: Could not find startState emit 2')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
