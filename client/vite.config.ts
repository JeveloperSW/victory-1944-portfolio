import { defineConfig } from 'vite';

/**
 * 개발 서버는 루프백에만 바인딩한다(공개 노출 금지).
 * 5173 Origin은 앱 개발 서버의 CORS 허용목록 기본값에 들어 있다(D-026).
 */
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
});
