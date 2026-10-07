<template>
  <!-- 此组件简单包装 VFab，但将其传送到路由视图外层，避免其在页面过渡动画时错位 -->
  <teleport v-if="domReady" to="#layout-main">
    <v-fab :active="showFab" v-bind="$attrs" transition="slide-y-reverse-transition" />
  </teleport>
</template>

<script setup lang="ts">
defineOptions({ inheritAttrs: false });

const domReady = ref(false);
const showFab = ref(false);

onMounted(async () => {
  await nextTick();
  domReady.value = true;
  await nextTick();
  showFab.value = true;
});
</script>

<style scoped>
.v-fab--app :deep(.v-fab__container) {
  margin: 1.5em;
}
</style>
