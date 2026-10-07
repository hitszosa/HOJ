<template>
  <v-menu activator="parent" location="top end" origin="bottom center" min-width="0px">
    <v-list
      density="compact"
      :items="[
        { title: $t('nav.colorThemes.dark'), value: 'dark' },
        { title: $t('nav.colorThemes.light'), value: 'light' },
        { title: $t('nav.colorThemes.systemDefault'), value: '' },
      ]"
      @update:selected="updateTheme as any"
    >
    </v-list>
  </v-menu>
</template>

<script setup lang="ts">
import { usePreferenceStore } from "@/stores/theme";
import { useTheme } from "vuetify";

const preferences = usePreferenceStore();

/// 切换主题
const theme = useTheme();

function updateTheme(v: ("light" | "dark" | null)[]) {
  preferences.setTheme(v[0] || null);
  theme.change(preferences.themeName);
}
</script>
