<template>
  <DefaultLayout
    stage-title="文档中心"
    :initial-opened-nav-groups="['user-guide']"
  >
    <template #main-wrapper>
      <v-container fluid class="docs-content pa-0">
        <v-list v-if="docRoutes.length" nav><ListItemFromRoutes :routes="docRoutes" prefix="/docs/" /></v-list>
        <router-view v-slot="{ Component, route }">
          <transition mode="out-in" name="fade">
            <keep-alive :max="6">
              <component :is="Component" :key="route.path" ref="currentDoc" />
            </keep-alive>
          </transition>
        </router-view>
      </v-container>
    </template>
  </DefaultLayout>
</template>

<script lang="ts" setup>
import { ApiGetCurrentUser } from "@/api/user";
import DefaultLayout from "@/layouts/default.vue";
import { useAppStore } from "@/stores/app";
// import { setDocumentTitle } from "@/utils/page";

const store = useAppStore();
const router = useRouter();

const docRoutes =
  router
    .getRoutes()
    .find(
      (r) =>
        r.path === "/docs" &&
        r.children?.some((child) => child.path === "" && child.children?.length),
    )
    ?.children?.find((r) => r.path === "")
    ?.children?.filter((r) => r.path !== "") || [];

onMounted(async () => {
  try {
    const response = await ApiGetCurrentUser();
    store.updateUser(response.data);
  } catch {}
});
</script>

<style lang="scss">
@use "sass:meta";

.docs-content .markdown-body {
  min-height: calc(100vh - var(--v-layout-top) - var(--v-layout-bottom));
  min-height: calc(100dvh - var(--v-layout-top) - var(--v-layout-bottom));
  padding: 16px;
}

@media (min-width: 960px) {
  .docs-content .markdown-body {
    padding: 32px;
  }
}

.v-theme--light {
  /* 若直接 @import，不管用！ */
  @include meta.load-css("github-markdown-css/github-markdown-light.css");

  .markdown-body {
    background-color: rgb(var(--v-theme-surface));
    color: rgb(var(--v-theme-on-surface));
  }
}

.v-theme--dark {
  @include meta.load-css("github-markdown-css/github-markdown-dark.css");

  .markdown-body {
    background-color: rgb(var(--v-theme-surface));
    color: rgb(var(--v-theme-on-surface));
  }
}
</style>
