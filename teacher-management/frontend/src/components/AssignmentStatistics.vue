<template>
  <v-skeleton-loader :loading="loading">
    <v-card width="100%">
      <v-card-title class="d-flex align-center">
        <h3 class="text-headline-small my-2">{{ t('statistics.title') }}</h3>
        <v-spacer />
        <v-btn icon="mdi-refresh" flat @click="refresh" />
      </v-card-title>
      <v-row>
        <v-col class="mx-4" v-for="(item, key, index) in summaryKeyName" :key="index">
          <v-card flat>
            <v-card-title tag="h3" class="my-2">{{ item }}</v-card-title>
            <v-card-text>{{
              typeof summaryData[key] === "number"
                ? (Math.round(summaryData[key] * 100) / 100).toFixed(2)
                : "--.--"
            }}</v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </v-card>
  </v-skeleton-loader>
</template>

<script setup lang="ts">
import { ApiAssignmentStatistics, AssignmentStatistics } from "@/api/course";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  assignmentId: number;
}>();

const { t } = useI18n();

const loading = ref(true);
const summaryData = ref({} as AssignmentStatistics);
const summaryKeyName = computed(() => ({
  average: t('statistics.average'),
  highest: t('statistics.highest'),
  lowest: t('statistics.lowest'),
  median: t('statistics.median'),
}));

async function refresh() {
  loading.value = true;
  const resp = await ApiAssignmentStatistics(props.assignmentId);
  summaryData.value = resp.data;
  loading.value = false;
}

onBeforeMount(refresh);
</script>

<i18n lang="yaml">
zh:
  statistics:
    title: 数据统计
    average: 平均分
    highest: 最高分
    lowest: 最低分
    median: 中位数
en:
  statistics:
    title: Statistics
    average: Average Score
    highest: Highest Score
    lowest: Lowest Score
    median: Median Score
</i18n>
