import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      util: 'util/',                    // полифилл util
      events: 'events/',                // полифилл events
      buffer: 'buffer/',                // полифилл buffer
      process: 'process/browser',       // полифилл process
      stream: 'stream-browserify',      // полифилл stream
    },
  },
  define: {
    global: 'window',
    'process.env': {},                  // чтобы обращения к process.env не падали
  },
  optimizeDeps: {
    include: ['util', 'events', 'buffer', 'process', 'stream-browserify'],
  },
});
