<template>
  <v-menu activator="parent" location="top end" origin="bottom center">
    <v-list
      density="compact"
      width="8em"
      :items="[
        { title: '简体中文', value: 'zh' },
        { title: 'English', value: 'en' },
      ]"
      @update:selected="switchLanguage as any"
    >
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { usePreferenceStore } from "@/stores/theme";
import { useI18n } from "vue-i18n";
import { useLocale } from "vuetify";

const { locale } = useI18n({ useScope: "global" });
const { current: currentVuetifyLocale } = useLocale();
const preferences = usePreferenceStore();

/// 切换语言
function switchLanguage(lang: ("en" | "zh")[]) {
  locale.value = lang[0];
  currentVuetifyLocale.value = lang[0] === "en" ? "en" : "zhHans";
  preferences.language = lang[0];
}
</script>
