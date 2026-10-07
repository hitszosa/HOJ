<template>
  <v-container>
    <TopNavigation
      :items="[
        { title: '课程列表', to: { name: 'courses-list' } },
        {
          title: courseInfo.title,
          to: { name: 'assignments-list', params: { courseId } },
        },
        { title: ' 课程数据统计' },
      ]"
    />
    <v-row class="mx-auto my-2 align-center">
      <h2 class="text-headline-large font-weight-light">
        {{ courseInfo.title }} 课程数据统计
      </h2>
      <v-spacer />
      <v-btn icon="mdi-refresh" @click="init" />
    </v-row>
    <v-skeleton-loader :loading type="table">
      <v-row>
        <v-col cols="12">
          <v-card>
            <v-card-title class="text-headline-small my-2" tag="h3"
              >作业分数</v-card-title
            >
            <v-card-text>
              <div v-if="showChart">
                <Chart :options />
              </div>
              <div v-else>加载中</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12">
          <v-card>
            <v-card-title class="d-flex align-center">
              <h3 class="text-headline-small my-2">分数表</h3>

              <v-spacer style="flex: 4 0 auto" />
              <v-btn
                color="primary"
                @click="submissionsTableSave"
                class="me-2"
                size="small"
                variant="tonal"
                text="保存为CSV"
                append-icon="mdi-download"
              />
              <v-text-field
                v-model="search"
                density="compact"
                append-inner-icon="mdi-magnify"
                variant="solo-filled"
                flat
                label="搜索"
                single-line
                hide-details
                style="flex: 1 0 8em"
              />
            </v-card-title>
            <v-data-table
              :headers="submissionsTableHeaders"
              :items="submissionsTableItems"
              :search="search"
            />
          </v-card>
        </v-col>
      </v-row>
    </v-skeleton-loader>
  </v-container>
</template>

<script setup lang="ts">
import {
  ApiCourseStatistics,
  ApiGetCourseAssignments,
  ApiGetCourseInfo,
  ApiGetSubmissions,
  Assignment,
} from "@/api/course";
import type { AssignmentStatistics, Submission } from "@/api/course";
import { format } from "date-fns";
import { Chart } from "highcharts-vue";
import Highcharts from "highcharts";
import { useTheme } from "vuetify";
// @ts-expect-error 该深路径导入无类型声明
import DarkUnicaTheme from "highcharts/es-modules/Extensions/Themes/DarkUnica";

const props = defineProps<{
  courseId: string;
}>();

const theme = useTheme();

const statisticsData = ref([] as AssignmentStatistics[]);
const assignmentsData = ref([] as Assignment[]);
const courseInfo = ref({ title: "..." });
const submissionsData = ref([
  {
    id: 26,
    user: { id: 60, username: "BJ9990102", real_name: "朱晶", role: 0 },
    submit_time: "2019-11-19T23:00:01.680539+08:00",
    status: 1,
    score: 50,
    assignment: 6,
  },
] as Submission[]);

const search = ref("");
const loading = ref(true);
const showChart = ref(true);

async function init() {
  loading.value = true;
  ApiGetCourseInfo(props.courseId).then((resp) => {
    courseInfo.value = resp.data;
  });

  assignmentsData.value = (await ApiGetCourseAssignments(props.courseId)).data;
  statisticsData.value = (await ApiCourseStatistics(props.courseId)).data;
  submissionsData.value = (await ApiGetSubmissions(props.courseId)).data;
  loading.value = false;
}

watch(() => props.courseId, init, { immediate: true });

const submissionsTableHeaders = computed(() =>
  [
    { title: "用户名/学号", value: "username" },
    { title: "姓名", value: "real_name" },
    ...assignmentsData.value
      .filter((a) => a.published)
      .map((a) => ({ title: a.title, value: `q${a.id}` })),
  ].map((i) => ({ sortable: true, ...i })),
);

// 以下计算值结果形如：
// [
//   { "username": "BJ9990102", "real_name": "朱晶", "q6": 50 },
//   { "username": ... },
// ]
const submissionsTableItems = computed(() => {
  const result = Object.groupBy(
    submissionsData.value.filter((s) => s.status === 1),
    ({ user }) => user.username,
  );
  return Object.entries(result).map((entry) => {
    const submissionList = entry[1]!;
    return Object.fromEntries([
      ["username", submissionList[0].user.username],
      ["real_name", submissionList[0].user.real_name],
      ...submissionList.map((s) => [`q${s.assignment}`, s.score]),
    ]);
  });
});

function findAssignment(id: number) {
  return assignmentsData.value.filter((a) => a.id === id)[0];
}

const chartOptions = computed((): Highcharts.Options => {
  const data = statisticsData.value;
  return {
    // chart: { type: "column" },
    title: { text: "作业分数柱状图" },
    xAxis: {
      categories: data.map((v) => findAssignment(v.id).title || `${v.id}`),
      crosshair: true,
    },
    yAxis: {
      min: 0,
      max: 100,
      title: { text: "分数" },
    },
    plotOptions: {
      column: {
        pointPadding: 0.2,
        borderWidth: 0,
      },
    },
    series: [
      { name: "最高分", data: data.map((i) => i.highest) },
      { name: "平均分", data: data.map((i) => i.average) },
      { name: "中位数", data: data.map((i) => i.median) },
      { name: "最低分", data: data.map((i) => i.lowest) },
    ].map((i) => ({ type: "column", ...i })), // typescript 要求每组 serie 有 type 属性
  };
});

const options = computed(() =>
  Highcharts.merge(
    theme.global.name.value === "dark" ? DarkUnicaTheme.options : {},
    chartOptions.value,
  ),
);

function submissionsTableSave() {
  const today = format(new Date(), "yyyy-MM-dd");
  const filename = `${courseInfo.value.title}分数汇总_${today}.csv`;
  const items = submissionsTableItems.value;
  const headers = submissionsTableHeaders.value;
  const text = [headers.map((v) => v.title).join(",")]
    .concat(items.map((i) => headers.map((key) => i[key.value]).join(",")))
    .join("\n");

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function forceRefreshChart() {
  showChart.value = false;
  await nextTick();
  showChart.value = true;
}
watch(theme.name, forceRefreshChart);
</script>

<route lang="yaml">
name: course-statistics
props: true
meta:
  title: 课程数据统计
</route>
