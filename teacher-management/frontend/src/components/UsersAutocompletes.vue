<template>
  <v-autocomplete
    :label="label"
    v-model="selectedIds"
    chips
    multiple
    :prepend-icon="prependIcon"
    auto-select-first
    no-filter
    :items
    item-title="searchName"
    item-value="id"
    :loading="isLoading"
    :rules
    :search="searchKeyword"
    :suffix="`共${selectedIds?.length}人`"
    @update:search="searchInput"
    @update:focused="onFocus"
  >
    <template #chip="{ props, internalItem: item, index }">
      <template v-if="index < maxChips">
        <v-chip
          v-bind="props"
          label
          :text="getSearchNameById(item.value)"
          :size="chipSize"
        >
          <template #append v-if="index === selectedIds!.length - 1">
            <v-icon v-if="maxChips > DEFAULT_MAX_CHIPS" @click="showLessChips">
              mdi-chevron-left-circle-outline
            </v-icon>
          </template>
        </v-chip>
      </template>
      <template v-else-if="index === maxChips">
        <v-chip
          v-bind="props"
          :size="chipSize"
          label
          color="info"
          :text="`其余${selectedIds!.length - maxChips}人`"
        >
          <template #append>
            <v-icon v-if="maxChips > DEFAULT_MAX_CHIPS" @click="showLessChips"
              >mdi-chevron-left-circle-outline</v-icon
            >
            <v-icon @click="showMoreChips">mdi-dots-horizontal-circle-outline</v-icon>
          </template>
        </v-chip>
      </template>
    </template>
    <template #append-item>
      <template v-if="items.length && hasMore">
        <v-list-item v-intersect="(i: boolean) => i && loadMore()">
          加载中……
        </v-list-item>
      </template>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { throttle } from "lodash-es";
import { ApiFuzzyUserLookup } from "@/api/user";
import type { UserInfo } from "@/api/user";
import { useUsersStore } from "@/stores/users";
import { VChip } from "vuetify/components";

const props = defineProps<{
  label: string;
  prependIcon?: string;
  roleFilter?: number;
  includeAdministrators?: boolean;
  chipSize?: VChip["$props"]["size"];
  rules?: ((v: any) => string | boolean)[];
}>();

const selectedIds = defineModel<number[]>();

const usersStore = useUsersStore();

const searchKeyword = ref("");
const pageNum = ref(1);
const hasMore = ref(false);
const isLoading = ref(false);
const items = ref<(UserInfo & { searchName: string })[]>([]);

const DEFAULT_MAX_CHIPS = 30;
const maxChips = ref(DEFAULT_MAX_CHIPS);

let setIsLoadingTimer = 0;

const getSearchNameById = (i: number) => {
  const u = usersStore.userByIdMap.get(i);
  return u === undefined ? `[${i}]` : getSearchName(u);
};
const getSearchName = (u: UserInfo) => `${u.username} - ${u.real_name}`;

const addSearchName = (u: UserInfo) => ({
  searchName: getSearchName(u),
  ...u,
});

const onFocus = (focused: boolean) => {
  if (focused) {
    showLessChips(); // 否则会在大数据情景下卡顿
    if (!items.value.length) searchUsers(searchKeyword.value);
  }
};

const searchUsers = async (key: string, reset = false) => {
  if (reset) {
    pageNum.value = 1;
  }

  try {
    // 避免进度条闪烁
    clearTimeout(setIsLoadingTimer);
    setIsLoadingTimer = window.setTimeout(() => (isLoading.value = true), 200);

    const responses = await Promise.all(
      (props.includeAdministrators && props.roleFilter === 1 ? [1, 2] : [props.roleFilter])
        .map(role => ApiFuzzyUserLookup(key, 100, pageNum.value, role, false)),
    );
    const data = {
      result: responses.flatMap(response => response.data.result).sort((a, b) => a.id - b.id),
      has_more_pages: responses.some(response => response.data.has_more_pages),
    };

    usersStore.updateMap(data.result);

    if (pageNum.value === 1) {
      items.value = data.result.map(addSearchName);
    } else {
      items.value = items.value.concat(data.result.map(addSearchName));
    }

    hasMore.value = data.has_more_pages;
    pageNum.value++;
  } finally {
    clearTimeout(setIsLoadingTimer);
    isLoading.value = false;
  }
};

const throttledSearchUsers = throttle(searchUsers, 400);

const searchInput = (key: string) => {
  searchKeyword.value = key;
  throttledSearchUsers(key, true);
};

const loadMore = () => {
  if (!isLoading.value && hasMore.value) {
    throttledSearchUsers(searchKeyword.value);
  }
};

const showMoreChips = () => {
  maxChips.value = Math.ceil(maxChips.value * 2);
};

const showLessChips = () => {
  maxChips.value = DEFAULT_MAX_CHIPS;
};
</script>
