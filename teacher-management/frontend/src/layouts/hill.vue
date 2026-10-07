<template>
  <v-main class="my-background-hill d-flex flex-column">
    <!-- Background container with two theme options -->
    <div class="background-container">
      <div
        class="background-image light-bg"
        :class="{ active: preferences.themeName === 'light' }"
      ></div>
      <div
        class="background-image dark-bg"
        :class="{ active: preferences.themeName === 'dark' }"
      ></div>
    </div>
    <router-view />
  </v-main>
  <div class="position-absolute bottom-0 d-flex justify-center w-100 my-2 ga-4">
    <v-btn icon>
      <v-icon>mdi-translate</v-icon>
      <SwitchLanguageMenu />
    </v-btn>
    <v-btn icon>
      <v-icon>mdi-weather-night</v-icon>
      <SwitchThemeMenu />
    </v-btn>
  </div>
</template>

<script lang="ts" setup>
import { usePreferenceStore } from "@/stores/theme";
const preferences = usePreferenceStore();
</script>

<style>
.background-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

.background-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  opacity: 0;
  transition: opacity 3s ease; /* Adjust transition duration as needed */
}

.background-image.active {
  opacity: 1;
}

.light-bg {
  background-image: url("/background-hitsz-day.jpg");
}

.dark-bg {
  background-image: url("/background-hitsz-night.jpg");
}
</style>
