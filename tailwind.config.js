/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/settings/**/*.{ts,tsx}', './src/renderer/src/components/SettingsView.tsx'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      fontFamily: {
        sans: ['"SF Pro Text"', '"PingFang SC"', 'Inter', 'Arial', 'sans-serif']
      }
    }
  },
  plugins: []
}
