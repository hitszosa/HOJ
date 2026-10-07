<template>
  <div class="virtual-collection">
    <ul v-if="mode === 'list'" class="virtual-collection-list">
      <li v-for="item in items" :key="item.id">
        <slot :item="item" />
      </li>
    </ul>
    <div v-else role="list" class="virtual-card-collection">
      <v-virtual-scroll
        :key="columns"
        :items="rows"
        item-key="id"
        :item-height="estimatedRowHeight"
        renderless
      >
        <template #default="slotProps">
          <div
            v-if="'itemRef' in slotProps"
            :ref="slotProps.itemRef"
            class="virtual-card-row"
            :style="gridStyle"
          >
            <div
              v-for="(item, column) in slotProps.item.items"
              :key="item.id"
              class="virtual-card-cell"
              role="listitem"
              :aria-posinset="slotProps.index * columns + column + 1"
              :aria-setsize="items.length"
            >
              <slot :item="item" />
            </div>
          </div>
        </template>
      </v-virtual-scroll>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: number | string }">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, watch } from "vue";
import { useDisplay } from "vuetify";

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    mode: "list" | "card";
    estimatedRowHeight?: number;
  }>(),
  { estimatedRowHeight: 360 },
);

const { smAndUp, lgAndUp, xlAndUp } = useDisplay();
const columns = computed(() =>
  xlAndUp.value ? 4 : lgAndUp.value ? 3 : smAndUp.value ? 2 : 1,
);
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
}));
const rows = computed(() => {
  const result: { id: number | string; items: T[] }[] = [];
  for (let start = 0; start < props.items.length; start += columns.value) {
    result.push({
      id: props.items[start].id,
      items: props.items.slice(start, start + columns.value),
    });
  }
  return result;
});
let refreshFrame = 0;

async function syncPageScroll() {
  await nextTick();
  cancelAnimationFrame(refreshFrame);
  refreshFrame = requestAnimationFrame(() => {
    // The renderless virtualizer listens to the page, including after remounts
    // at a nonzero scroll offset (responsive columns and keep-alive navigation).
    document.dispatchEvent(new Event("scroll"));
  });
}

onMounted(syncPageScroll);
onActivated(syncPageScroll);
watch([columns, () => props.mode], syncPageScroll);
onBeforeUnmount(() => cancelAnimationFrame(refreshFrame));
</script>

<style scoped>
.virtual-collection {
  width: 100%;
  min-width: 0;
}

.virtual-collection-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  overflow: hidden;
}

.virtual-collection-list > li + li {
  border-top: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.virtual-card-row {
  display: grid;
  gap: 8px;
  padding: 4px 4px 12px;
}

.virtual-card-cell {
  min-width: 0;
}

.virtual-card-cell :slotted(.v-card) {
  height: 100%;
}
</style>
