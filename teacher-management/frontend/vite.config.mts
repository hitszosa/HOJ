// Plugins
import AutoImport from "unplugin-auto-import/vite";
import browserslist from "browserslist";
import { browserslistToTargets } from "lightningcss";
import Components from "unplugin-vue-components/vite";
import Fonts from "unplugin-fonts/vite";
import Layouts from "vite-plugin-vue-layouts";
import Vue from "@vitejs/plugin-vue";
import VueRouter from "vue-router/vite";
import Vuetify, { transformAssetUrls } from "vite-plugin-vuetify";
import legacy from "@vitejs/plugin-legacy";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";
import vueDevTools from "vite-plugin-vue-devtools";
import Markdown from "unplugin-vue-markdown/vite";

// Utilities
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import { extendRoute } from "./src/layouts/transform";

const GRADER_BACKEND_URL =
  process.env.VITE_GRADER_BACKEND_URL || "http://127.0.0.1:8000/";
// https://vitejs.dev/config/
export default defineConfig({
  base: "/management/",
  plugins: [
    legacy({
      // 注：学校有的实验室装有 chrome 75 版本
      modernTargets: "since 2019-06-01, not dead",
      modernPolyfills: true,
      renderLegacyChunks: false,
    }),
    VueRouter({
      extendRoute: extendRoute,
      extensions: [".vue", ".md"],
      dts: "src/route-map.d.ts",
    }),
    Layouts(),
    AutoImport({
      imports: ["vue", "vue-router"],
      dts: "src/auto-imports.d.ts",
      eslintrc: {
        enabled: true,
      },
      vueTemplate: true,
    }),
    Components({
      dts: "src/components.d.ts",
      extensions: ["vue", "md"],
      include: [/\.vue$/, /\.vue\?vue/, /\.md$/],
    }),
    Vue({
      include: [/\.vue$/, /\.md$/],
      template: { transformAssetUrls },
    }),
    // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
    Vuetify({
      autoImport: true,
      // 暂时未对 sass variables 做任何定制，目前可节省构建时间
      // styles: {
      //   configFile: "src/styles/settings.scss",
      // },
    }),
    Fonts({
      google: {
        families: [
          {
            name: "Roboto",
            styles: "wght@100;300;400;500;700;900",
          },
        ],
      },
    }),
    VueI18nPlugin({
      include: [path.resolve(__dirname, "./src/locales/**")],
    }),
    Markdown({}),
    vueDevTools(),
  ],
  optimizeDeps: {
    exclude: ["vuetify"],
  },
  define: { "process.env": {} },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    extensions: [".js", ".json", ".jsx", ".mjs", ".ts", ".tsx", ".vue"],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("./", import.meta.url)), fileURLToPath(new URL("../../frontend/src/lib", import.meta.url))] },
    port: 3000,
    watch: {
      ignored: ["/scripts/**", "/tmp/**"],
    },
    proxy: {
      // 将 /api 等请求转发给后端 dev server
      "^/(api|oauth|admin|static/(admin|drf-yasg)|swagger(-ui)?|)/.*": {
        target: GRADER_BACKEND_URL,
        changeOrigin: true,
        secure: true,
      },
    },
  },
  css: {
    transformer: "lightningcss",
    lightningcss: {
      targets: browserslistToTargets(browserslist("since 2019-06-01, not dead")),
    },
  },
  build: {
    assetsDir: "static",
    cssMinify: "lightningcss",
  },
});
