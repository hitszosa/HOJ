<template>
  <v-container>
    <div class="my-6">
      <h1 class="text-headline-large">{{ t('welcome', { name: store.user.real_name }) }}</h1>
      <p class="text-body-large text-medium-emphasis mt-3">{{ t(store.isTeacher ? 'intro' : 'studentIntro') }}</p>
    </div>
    <v-alert v-if="loadError" type="error" variant="tonal">{{ loadError }}<v-btn variant="text" @click="loadDashboard">{{ t('retry') }}</v-btn></v-alert>
    <v-row class="my-4">
      <v-col v-for="metric in metrics" :key="metric.label" cols="12" sm="4">
        <v-card variant="outlined" class="pa-5">
          <div class="text-body-medium text-medium-emphasis">{{ metric.label }}</div>
          <v-skeleton-loader v-if="loading" type="text" />
          <div v-else class="text-headline-large mt-3">{{ loadError ? '—' : metric.value }}</div>
        </v-card>
      </v-col>
    </v-row>
    <h2 class="text-title-large my-5">{{ t('recentWork') }}</h2>
    <v-skeleton-loader v-if="loading" type="list-item-two-line@3" />
    <v-list v-else-if="recentWork.length" lines="two" class="rounded border">
      <v-list-item v-for="item in recentWork" :key="item.batch_id"
        :title="item.title" :subtitle="`${item.courseTitle} · ${item.due_at ? t('due')+' '+FormatDate(item.due_at.replace(' ','T')) : t('noDeadline')}`"
        :href="`/assignments/${item.batch_id}`"
        prepend-icon="mdi-code-braces" append-icon="mdi-chevron-right" />
    </v-list>
    <v-empty-state v-else-if="!loadError" :title="t('noRecentWork')" />
  </v-container>
</template>
<script setup lang="ts">
import { useAppStore } from '@/stores/app';
import { ApiGetCoursesListWithRecentAssignments, FormatDate } from '@/api/course';
import type { CourseWithAssignments } from '@/api/course';
import { getGeneralErrorMsg } from '@/utils/error';
import { useI18n } from 'vue-i18n';
const store = useAppStore();
const { t } = useI18n();
const loading = ref(true);
const loadError = ref('');
const courses = ref<CourseWithAssignments[]>([]);
const assignments = computed(() => courses.value.flatMap(course =>
  course.programming.recent.map(assignment => ({ ...assignment, courseTitle: course.title }))));
const metrics = computed(() => [
  { label: t('courseCount'), value: courses.value.length },
  { label: t('recentCount'), value: courses.value.reduce((n,c)=>n+c.programming.assignment_count,0) },
  { label: t('openCount'), value: courses.value.reduce((n,c)=>n+c.programming.open_count,0) },
]);
const recentWork = computed(() => [...assignments.value]
  .sort((a, b) => b.batch_id-a.batch_id).slice(0, 5));
async function loadDashboard() {
  loading.value = true;
  loadError.value='';
  try { courses.value = (await ApiGetCoursesListWithRecentAssignments()).data; }
  catch (error: any) { loadError.value=getGeneralErrorMsg(error); }
  finally { loading.value = false; }
}
onActivated(loadDashboard);
</script>
<route lang="yaml">
name: home
meta:
  title: 教学总览
  titleEn: Teaching Dashboard
</route>
<i18n lang="yaml">
zh:
  welcome: "{name}，欢迎回来"
  intro: 在课程中管理名单、布置作业和查看成绩。
  studentIntro: 在课程中查看作业、完成练习和查询成绩。
  courseCount: 课程数
  recentCount: 已发布作业
  openCount: 可提交作业
  recentWork: 最近的作业
  due: 截止于
  noDeadline: 未设截止
  retry: 重试
  noRecentWork: 暂无近期作业
en:
  welcome: "Welcome back, {name}"
  intro: Manage rosters, assignments and grades in your courses.
  studentIntro: View assignments, complete practice and check your grades in your courses.
  courseCount: Courses
  recentCount: Published assignments
  openCount: Open assignments
  recentWork: Recent assignments
  due: Due
  noDeadline: No deadline
  retry: Retry
  noRecentWork: No recent assignments
</i18n>
