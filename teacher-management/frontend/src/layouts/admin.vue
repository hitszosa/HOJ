<template>
  <DefaultLayout :show-router-view="user.role >= 1" />
</template>

<script lang="ts" setup>
import DefaultLayout from "@/layouts/default.vue";
import { useAppStore } from "@/stores/app";
import { storeToRefs } from "pinia";

const { user } = storeToRefs(useAppStore());
const { sendSnack } = useAppStore();

onMounted(() => {
  if (user.value.role === 0) {
    sendSnack("您没有权限访问此页面", "error", -1);
  }
});
</script>
