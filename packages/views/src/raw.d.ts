// Vite (electron-vite's main build and vitest) inlines files imported with ?raw as strings.
declare module "*?raw" {
  const text: string;
  export default text;
}
