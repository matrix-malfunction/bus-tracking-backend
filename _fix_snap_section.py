path = r'w:\Final year project\backend\src\controllers\locationController.js'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the start and end of the snap section
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if '// === ROUTE SNAPPING (Corridor Locking) ===' in line:
        start_idx = i
    if start_idx is not None and '// === SOCKET EMIT ===' in line:
        end_idx = i
        break

if start_idx is not None and end_idx is not None:
    # Replace the snap section with just the SOCKET EMIT comment
    new_lines = lines[:start_idx] + lines[end_idx:]
    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    print(f'Replaced lines {start_idx+1} to {end_idx}')
else:
    print(f'Could not find boundaries: start={start_idx}, end={end_idx}')
