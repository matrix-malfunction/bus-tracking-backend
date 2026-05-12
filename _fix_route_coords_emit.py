import re

path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove delete emitPayload.routeCoords lines
content = content.replace('delete emitPayload.routeCoords;\n', '')
print('Removed delete emitPayload.routeCoords lines')

# 2. Add routeCoords back to routeInfo spread in updateLocation emit
old_route_info = '''          ...(routeInfo && {
            routeId: routeInfo.routeId,
            routeName: routeInfo.routeName,
            routeColor: routeInfo.routeColor,
            direction: routeInfo.direction,
            tripId: routeInfo.tripId,
          }),'''

new_route_info = '''          ...(routeInfo && {
            routeId: routeInfo.routeId,
            routeName: routeInfo.routeName,
            routeColor: routeInfo.routeColor,
            direction: routeInfo.direction,
            tripId: routeInfo.tripId,
            routeCoords: routeInfo.routeCoords || [],
          }),'''

if old_route_info in content:
    content = content.replace(old_route_info, new_route_info)
    print('Added routeCoords to routeInfo spread in updateLocation')
else:
    print('WARNING: Could not find routeInfo spread in updateLocation')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print('locationController.js updated')
