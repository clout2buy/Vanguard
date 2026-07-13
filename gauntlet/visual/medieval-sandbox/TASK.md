# Build the Living Marches medieval 3D sandbox

Create a visually rich, real-time 3D medieval world sandbox as a single standalone Windows executable named `MedievalSandbox.exe`. Build it from the supplied dependency-free C++17 workspace using only Win32 and system OpenGL libraries. Do not download an engine, library, model, texture, audio file, or other asset; generate the world, geometry, colors, animation, and effects procedurally in code.

The finished experience must include:

1. A navigable 3D landscape with rolling terrain, a visible river or lake, roads, trees, rocks, atmospheric sky/fog, depth testing, and lighting that makes the scene readable.
2. A substantial medieval settlement with at least 20 distinct structures or landmarks: varied houses, a keep or castle, walls or towers, a market area, and environmental props. It should read as a designed town rather than a repeated grid of identical boxes.
3. At least 15 animated townspeople following visible walking routes, at least 12 birds flocking or circling above the town, and at least one large animated dragon flying through the world. The dragon must be visually distinct from the birds and emit a visible fire or ember effect during its route.
4. A changing day/night atmosphere with moving sun or moon lighting, a controllable camera, collision or terrain-height handling that prevents the player from simply falling through the world, and an on-screen HUD or help overlay describing controls and world state.
5. Normal launch must open an interactive 1280×720-or-larger window. Support keyboard camera movement and a clear quit control. Keep the simulation responsive for an extended session.
6. `--self-test PATH` must run deterministic noninteractive simulation checks, write a JSON report to `PATH`, and exit zero only when the real world systems are initialized. The report must include numeric `buildings`, `villagers`, `birds`, and `dragons` counts plus a `systems` array.
7. `--capture PATH` must initialize the same renderer and world used by normal play, advance to a deterministic showcase frame, render it, save a 24- or 32-bit BMP image to `PATH`, and exit. Do not fake the capture with a separate image generator.

Keep source code under `src/`. `npm test` is the fixed build and acceptance command: it compiles a fresh executable, runs the self-test, renders the showcase capture, and checks basic image complexity. Finish only after `npm test` passes and you have reviewed the complete source for correctness, visual composition, resource cleanup, and accidental test-only shortcuts.
