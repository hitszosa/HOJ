<template>
  <v-app>
    <router-view />
    <GlobalSnackbar />
  </v-app>
</template>

<script lang="ts" setup>
import { useLocale, useTheme } from "vuetify";
import { usePreferenceStore } from "@/stores/theme";
import GlobalSnackbar from "./components/GlobalSnackbar.vue";
import { useI18n } from "vue-i18n";

const preferences = usePreferenceStore();

// 主题
useTheme().change(preferences.themeName);

// 语言
const { locale } = useI18n({ useScope: "global" });
const { current: currentVuetifyLocale } = useLocale();
locale.value = preferences.getLocale();
currentVuetifyLocale.value = locale.value === "en" ? "en" : "zhHans";
addEventListener("languagechange", () => {
  preferences.language = null;
  locale.value = preferences.getLocale();
  currentVuetifyLocale.value = locale.value === "en" ? "en" : "zhHans";
});
</script>
