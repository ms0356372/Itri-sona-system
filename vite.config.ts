import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({plugins:[react(),VitePWA({registerType:'autoUpdate',includeAssets:['icon.svg'],manifest:{name:'超音波健檢報到暨診間管理系統',short_name:'超音波健檢',description:'巡迴健檢超音波報到、叫號與診間管理',theme_color:'#0f766e',background_color:'#f0fdfa',display:'standalone',orientation:'any',start_url:'/',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]},workbox:{navigateFallback:'/index.html'}})],test:{environment:'jsdom',setupFiles:['./src/test/setup.ts']}});
