import re
path = r'w:\Final year project\backend\src\utils\progressionEngine.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove the old step 3 block (lines 1254-1264) and the duplicate let rawNextStopIndex in step 4
old_block = re.compile(
    r'      // 3\. Find raw next stop ahead of bus on the route polyline\n'
    r'      let rawNextStopIndex = -1;\n'
    r'      for \(let i = 0; i < demoStops\.length; i\+\+\) \{\n'
    r'        if \(stopCoordIndices\[i\] >= nearestCoordIndex\) \{\n'
    r'          rawNextStopIndex = i;\n'
    r'          break;\n'
    r'        \}\n'
    r'      \}\n'
    r'      if \(rawNextStopIndex === -1\) \{\n'
    r'        rawNextStopIndex = demoStops\.length - 1;\n'
    r'      \}\n\n'
    r'      // 4\. GPS-authoritative stop determination\n'
    r'      // Compute raw current/next from nearest route coordinate\n'
    r'      let rawCurrentStopIndex = -1;\n'
    r'      let rawNextStopIndex = -1;',
    re.MULTILINE
)

new_block = (
    '      // 3-4. GPS-authoritative stop determination\n'
    '      // Compute raw current/next from nearest route coordinate\n'
    '      let rawCurrentStopIndex = -1;\n'
    '      let rawNextStopIndex = -1;'
)

content_new = old_block.sub(new_block, content, count=1)
if content_new == content:
    print('Regex did not match! Falling back to simple string replacement.')
    # Fallback: just remove the duplicate let rawNextStopIndex = -1; line
    content_new = content.replace(
        '      let rawCurrentStopIndex = -1;\n      let rawNextStopIndex = -1;',
        '      let rawCurrentStopIndex = -1;\n      let rawNextStopIndex = -1;',
        1
    )
    # Actually that's the same. Let me just delete the old block via line numbers.
    lines = content.splitlines(keepends=True)
    # Find line indices for old block
    start_idx = None
    end_idx = None
    for i, line in enumerate(lines):
        if '// 3. Find raw next stop ahead' in line:
            start_idx = i
        if start_idx is not None and '// 4. GPS-authoritative stop determination' in line:
            end_idx = i + 2  # include comment line and blank line before
            break
    if start_idx is not None and end_idx is not None:
        # Remove old step 3 block and the duplicate declaration in step 4
        # Keep: comment "3-4. GPS-authoritative...", blank line, let rawCurrent..., let rawNext...
        new_lines = lines[:start_idx] + [
            '      // 3-4. GPS-authoritative stop determination\n',
            '      // Compute raw current/next from nearest route coordinate\n',
            '      let rawCurrentStopIndex = -1;\n',
            '      let rawNextStopIndex = -1;\n',
        ] + lines[end_idx + 1:]
        content_new = ''.join(new_lines)
        print('Line-based replacement done.')
    else:
        print('Could not find block boundaries')
else:
    print('Regex replacement done.')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content_new)

print('File written.')
