/// <reference types="vite/client" />

// TypeScript 6 tightened side-effect import resolution: bare CSS imports
// like `import './styles/global.css'` now error with TS2882 unless an
// ambient module declaration exists. Vite handles the actual loading at
// build time; this declaration only satisfies the type checker.
declare module '*.css';
