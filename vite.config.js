import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: { '/api': 'http://127.0.0.1:4180' }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replaceAll('\\', '/');
          if (!modulePath.includes('/node_modules/')) return;
          if (modulePath.includes('/node_modules/react-dom/')) return 'react-dom';
          if (modulePath.includes('/node_modules/react/') || modulePath.includes('/node_modules/scheduler/')) return 'react';
          if (modulePath.includes('/node_modules/@ant-design/icons/')) return 'icons';
          if (modulePath.includes('/node_modules/@ant-design/')) return 'antd-support';
          if (modulePath.includes('/node_modules/antd/')) return 'antd';
          if (modulePath.includes('/node_modules/rc-') || modulePath.includes('/node_modules/@rc-component/')) return 'rc';
          if (modulePath.includes('/node_modules/dayjs/')) return 'dayjs';
        }
      }
    }
  }
});
