<template>
  <v-snackbar
    v-model="snack.visible"
    :color="snack.type"
    :timeout="snack.timeout"
    :timer-color="snack.timeout === -1 ? undefined : `white`"
  >
    <v-progress-linear
      v-if="snack.progress.show"
      height="8"
      absolute
      :indeterminate="snack.progress.indeterminate"
      :model-value="snack.progress.value"
    />
    <div style="max-height: 50vh; overflow: auto">
      <span style="white-space: pre-wrap">{{ snack.message }}</span>
    </div>
    <template #actions>
      <v-btn
        v-if="snack.closable"
        variant="text"
        icon="mdi-close"
        density="comfortable"
        @click="snack.visible = false"
      />
    </template>
  </v-snackbar>
</template>

<script setup lang="ts">
import { useAppStore } from "@/stores/app";
import { storeToRefs } from "pinia";

const { snack } = storeToRefs(useAppStore());
</script>

<style scoped></style>
