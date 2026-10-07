<template>
  <div class="overflow-x-auto">
    <v-breadcrumbs
      active-color="secondary"
      :items="items"
      class="my-0"
      style="width: max-content"
    >
      <template #divider> <v-icon> mdi-chevron-right </v-icon> </template>
    </v-breadcrumbs>
  </div>
</template>

<script setup lang="ts">
import { VBreadcrumbs } from "vuetify/components";

defineProps<{
  items: VBreadcrumbs["$props"]["items"];
}>();
</script>
