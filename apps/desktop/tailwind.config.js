/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens aligned with the three-pane IDE layout.
        pane: {
          left: "#18181b", // zinc-900
          center: "#0e0e10", // near-black chat bg
          right: "#18181b",
          border: "#27272a", // zinc-800
        },
      },
    },
  },
  plugins: [],
};
