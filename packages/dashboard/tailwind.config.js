/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#0f1117',
        surface: '#1a1b23',
        'surface-hover': '#22232d',
        border: '#2a2b35',
        accent: '#6366f1',
        'accent-light': '#818cf8',
      },
      animation: {
        'wag': 'wag 0.4s ease-in-out infinite',
        'wiggle': 'wiggle 0.5s ease-in-out infinite',
        'float': 'float 1.5s ease-in-out forwards',
        'bounce-gentle': 'bounce-gentle 1s ease-in-out infinite',
        'flutter': 'flutter 0.15s ease-in-out infinite',
      },
      keyframes: {
        wag: {
          '0%, 100%': { transform: 'rotate(-10deg)' },
          '50%': { transform: 'rotate(10deg)' },
        },
        wiggle: {
          '0%, 100%': { transform: 'rotate(-5deg)' },
          '50%': { transform: 'rotate(5deg)' },
        },
        float: {
          '0%': { opacity: '1', transform: 'translateY(0)' },
          '100%': { opacity: '0', transform: 'translateY(-12px)' },
        },
        'bounce-gentle': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-2px)' },
        },
        flutter: {
          '0%, 100%': { transform: 'scaleX(1)' },
          '50%': { transform: 'scaleX(0.7)' },
        },
      },
    },
  },
  plugins: [],
};
