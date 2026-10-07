<template>
  <v-container style="max-width: 760px">
    <h1 class="text-headline-large my-6">{{ text('偏好设置','Preferences') }}</h1>
    <v-list lines="two" class="rounded border">
      <v-list-item :title="t('nav.displayMode')" :subtitle="t(`nav.displayModes.${preferences.courseView}`)" prepend-icon="mdi-view-grid">
        <template #append><v-btn variant="outlined" @click="preferences.cycleDisplayMode()">{{ text('切换','Change') }}</v-btn></template>
      </v-list-item>
      <v-list-item title="语言 / Language" :subtitle="t(`nav.languages.${locale}`)" prepend-icon="mdi-translate">
        <template #append><v-btn variant="outlined" @click="cycleLanguage">{{ text('切换','Change') }}</v-btn></template>
      </v-list-item>
      <v-list-item :title="t('nav.theme')" :subtitle="t(`nav.colorThemes.${preferences.selectedTheme || 'systemDefault'}`)" prepend-icon="mdi-theme-light-dark">
        <template #append><v-btn variant="outlined" @click="cycleTheme">{{ text('切换','Change') }}</v-btn></template>
      </v-list-item>
    </v-list>
  </v-container>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useLocale, useTheme } from 'vuetify';
import { usePreferenceStore } from '@/stores/theme';
const preferences=usePreferenceStore();
const {t,locale}=useI18n({useScope:'global'});
const {current:vuetifyLocale}=useLocale();
const theme=useTheme();
const text=(zh:string,en:string)=>locale.value==='en'?en:zh;
function cycleLanguage(){
 const next=locale.value==='en'?'zh':'en';
 preferences.language=next;locale.value=next;vuetifyLocale.value=next==='en'?'en':'zhHans';
}
function cycleTheme(){
 const options=['systemDefault','light','dark'] as const;
 const current=preferences.selectedTheme||'systemDefault';
 const next=options[(options.indexOf(current)+1)%options.length];
 preferences.setTheme(next==='systemDefault'?null:next);theme.change(preferences.themeName);
}
</script>
<route lang="yaml">
name: preferences
meta:
  title: 偏好设置
  titleEn: Preferences
</route>
