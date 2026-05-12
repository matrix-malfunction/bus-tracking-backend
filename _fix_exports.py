path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

old = '  haversineDistance,\n  GPS_JITTER_THRESHOLD_METERS // Export for unified use'
new = '  haversineDistance,\n  densifyRouteCoords, // Dense coordinate interpolation\n  GPS_JITTER_THRESHOLD_METERS // Export for unified use'

if old in content:
    content = content.replace(old, new)
    print('Fixed exports')
else:
    print('WARNING: Could not find exports block')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
