# React Bits Dither

Source: https://github.com/DavidHDev/react-bits/tree/main/src/content/Backgrounds/Dither
Demo: https://reactbits.dev/backgrounds/dither
Retrieved: 2026-09-16

`Dither.jsx` and `Dither.css` are the upstream implementation, formatted with
Biome. The shader, postprocessing, animation, and defaults are unchanged.
The accompanying license is copied from the upstream repository.

`Dither.d.ts` describes the public props without exposing React Three Fiber's
JSX augmentation to the applications' DOM and MDX components. The shared
`react-bits-dither.tsx` wrapper manages lazy loading, visibility, theme colors,
reduced motion, and a fallback when WebGL cannot initialize.
