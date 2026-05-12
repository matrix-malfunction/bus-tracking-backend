path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

marker = '        currentStopIndex,\n        currentStopId: currentStop?.stopId ?? null,'
if marker in content:
    content = content.replace(marker, '        currentStopIndex,\n        routeProgressIndex: currentStopIndex,\n        currentStopId: currentStop?.stopId ?? null,', 1)
    print('Replaced')
else:
    print('Marker not found')
    # Try to find the line
    for i, line in enumerate(content.splitlines()):
        if 'currentStopIndex,' in line and 'routeProgressIndex' not in content.splitlines()[i+1]:
            print(f'Found at line {i+1}: {repr(line)}')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
