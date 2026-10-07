<template>
  <template v-for="route in routesSorted" :key="route.path">
    <v-list-item
      v-if="!route.children"
      :to="{ name: route.name }"
      :title="
        (route.meta?.title as string) ??
        route.name
      "
      variant="flat"
    />
    <v-list-group v-if="route.children">
      <template #activator="{ props }">
        <v-list-item
          v-bind="props"
          :to="{ name: route.name }"
          :title="
            (route.meta?.title as string) ??
            route.path
          "
          variant="flat"
        />
      </template>
      <!-- 递归 -->
      <ListItemFromRoutes :routes="route.children" :prefix="prefix + route.path + '/'" />
    </v-list-group>
  </template>
</template>

<script setup lang="ts">
import { RouteRecordRaw } from "vue-router";

interface Props {
  routes: RouteRecordRaw[];
  prefix: string;
  listItemExtraProps?: Record<string, Record<string, string>>;
}

const { routes, prefix } = defineProps<Props>();

const getRouteSortKey = (route: RouteRecordRaw) => +((route.meta?.sortKey as string) || 0);

const routesSorted = routes.toSorted(
  (r1, r2) =>
    +!!r1.children - +!!r2.children || getRouteSortKey(r1) - getRouteSortKey(r2),
);

console.log("ListItemFromRoutes: ", routesSorted);
</script>
