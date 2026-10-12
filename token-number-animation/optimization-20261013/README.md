# Token digit-roll optimization comparison

Left: original Roll. Right: optimized Roll. Both use the existing App display font at 46px, actual renderer/CSS, and fixed mock data in native macOS Electron.

These GIFs are assembled from frames captured at fixed relative WAAPI times (0, 50, 100, 150, 200, 300, 450, 650, 850ms). They compare the animation envelope; they are not recordings of real-time frame delivery or evidence of FPS.

The source renderer was frozen at a41c0256ca6168a4ef5fbd87c61223d46ee602ae plus the local session visibility fix; the optimized source also adds adaptive envelope sampling and visible/changed-reading limits. The PR rebases these changes onto main without changing the renderer/core source hashes below.

SHA256:
- Original renderer: b082d43cc86de15b727d2b276c0ba31e89aff2e048a724a0d7bdadc8ad8eb71c
- Optimized renderer: 44201806f80208d829547942455550e6db356260650d35346c06959f22dd9f47
- Original animation core: f20129b3eeb2cca69bea46208b0917d292b8eef1906e3aa1ff405828c2b9dea2
- Optimized animation core: 1a48cf3b59fcd491094e81bc29539acc843a5ba302a10538d42c826f231be0ed
