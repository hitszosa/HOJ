<template>
  <v-card>
    <v-card-title class="my-2" tag="h3">{{ t("myProfile") }}</v-card-title>
    <v-card-text>
      <v-row density="compact">
        <v-col>{{ t("adminAssigned") }}</v-col>
      </v-row>
      <v-row density="compact">
        <v-col cols="4">
          <h4 class="text-grey">{{ t("username") }}</h4>
        </v-col>
        <v-col>{{ user.username }}</v-col>
      </v-row>
      <v-row density="compact">
        <v-col cols="4">
          <h4 class="text-grey">{{ t("realName") }}</h4>
        </v-col>
        <v-col>{{ user.real_name }}</v-col>
      </v-row>
      <v-row density="compact">
        <v-col cols="4">
          <h4 class="text-grey">{{ t("role") }}</h4>
        </v-col>
        <v-col>{{ roleName }}</v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { useAppStore } from '@/stores/app';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';

const store = useAppStore();
const { user, roleName } = storeToRefs(store);
const { t } = useI18n();
</script>

<style scoped>
h4 {
  margin: 0;
}
</style>
