/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        farm: {
          50: '#f2f9f4',
          100: '#e1f2e5',
          600: '#16a34a',
          800: '#166534',
          900: '#14532d',
        }
      }
    },
  },
  plugins: [],
}