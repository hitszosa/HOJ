<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-4 mt-6 mb-3">
      <h2 class="text-headline-large ma-0">{{ t("courses") }}</h2>
      <PageFilter v-model="filter" :label="t('filterCourses')" />
      <v-btn v-if="isTeacher" color="primary" prepend-icon="mdi-plus" @click="createCourse">{{ t('createCourse') }}</v-btn>
    </div>
    <v-alert v-if="loadError" type="error" variant="tonal">{{ loadError }}<v-btn variant="text" @click="refreshCourses">{{ t('retry') }}</v-btn></v-alert>
    <v-skeleton-loader :loading="loading" type="card@2">
      <v-empty-state
        v-if="!loadError && yearTermList.length === 0"
        :title="t('noCourses')"
        width="100%"
      />
      <v-tabs
        v-if="yearTermList.length && !hasFilter"
        v-model="selectedSemesterKey"
        :items="tabItems"
        color="secondary"
        class="w-100"
        show-arrows
      />
      <p
        v-if="hasFilter && yearTermList.length"
        class="text-body-medium text-medium-emphasis my-3"
        role="status"
      >
        {{ t("allSemesterResults", { count: filteredCourses.length }) }}
      </p>
      <v-empty-state
        v-if="yearTermList.length && filteredCourses.length === 0"
        :title="t('noMatchingCourses')"
        width="100%"
      />
      <VirtualCollection
        v-if="filteredCourses.length"
        :key="hasFilter ? 'search' : selectedSemesterKey"
        :items="filteredCourses"
        :mode="courseView"
        :estimated-row-height="360"
        class="mt-6"
      >
        <template #default="{ item: course }">
          <div v-if="courseView === 'list'" class="course-list-row">
            <router-link
              class="course-list-link"
              :to="{
                name: 'assignments-list',
                params: { courseId: String(course.id) },
              }"
              :title="`${t('enter')}: ${course.title}`"
            >
              <div class="course-list-content">
                <h3
                  class="course-list-title text-title-medium text-truncate ma-0"
                  :title="course.title"
                >
                  {{ course.title }}
                </h3>
                <p class="text-body-small text-medium-emphasis text-truncate ma-0 mt-1">
                  <template v-if="hasFilter">{{ getYearTermName(course) }} · </template>
                  {{ t("teachers", course.teachers.length) }}: {{ getTeachers(course) }}
                  <template v-if="course.programming.recent[0]">
                    · {{ course.programming.recent[0].title }} ·
                    {{ course.programming.recent[0].due_at ? dateFriendlyStr(new Date(course.programming.recent[0].due_at.replace(' ','T'))) : t('noDeadline') }}
                  </template>
                  <template v-else> · {{ t("noRecentAssignments") }}</template>
                </p>
              </div>
              <v-chip
                v-if="isAssistantFor(course)"
                class="ml-2 flex-shrink-0"
                size="x-small"
                color="deep-purple-lighten-2"
              >
                {{ t("TA") }}
              </v-chip>
              <v-icon class="ml-2 flex-shrink-0" size="small" aria-hidden="true"
                >mdi-chevron-right</v-icon
              >
            </router-link>
            <v-btn
              v-if="isTeacher || isAssistantFor(course)"
              class="mr-2 flex-shrink-0"
              :to="{
                name: 'course-statistics',
                params: { courseId: String(course.id) },
              }"
              icon="mdi-chart-box-outline"
              size="small"
              variant="text"
              :title="t('courseStatistics')"
              :aria-label="`${t('courseStatistics')}: ${course.title}`"
            />
          </div>
          <v-card v-else hover class="cursor-default">
            <v-card-title
              class="d-flex bg-surface-alt cursor-pointer align-center"
              @click="
                $router.push({
                  name: 'assignments-list',
                  params: { courseId: String(course.id) },
                })
              "
            >
              <h3
                class="text-headline-small my-1 text-truncate flex-grow-1"
                style="min-width: 0"
                :title="course.title"
              >
                {{ course.title }}
              </h3>
              <v-chip
                v-if="isAssistantFor(course)"
                class="ml-2 flex-shrink-0"
                size="small"
                color="deep-purple-lighten-2"
              >
                {{ t("TA") }}
              </v-chip>
            </v-card-title>
            <v-card-text>
              <div v-if="hasFilter" class="text-body-small text-medium-emphasis mt-3">
                {{ getYearTermName(course) }}
              </div>
              <div class="my-4">
                <strong class="text-grey">{{
                  t("teachers", course.teachers.length)
                }}</strong>
                <div>{{ getTeachers(course) }}</div>
              </div>
              <div class="mt-4">
                <div class="text-grey">
                  <strong v-if="course.programming.assignment_count">
                    {{ t("recentAssignments", {count:course.programming.assignment_count}) }}
                  </strong>
                  <strong v-else>{{ t("noRecentAssignments") }}</strong>
                </div>
                <v-row
                  v-for="assignment in course.programming.recent"
                  :key="assignment.batch_id"
                  align="center"
                  class="pb-1"
                  no-gutters
                >
                  <v-col><a :href="`/assignments/${assignment.batch_id}`">{{ assignment.title }}</a></v-col>
                  <v-col cols="auto">
                    <v-chip :color="assignment.due_at ? dueTimeColor(assignment) : 'primary'" size="small">
                      {{ assignment.due_at ? dateFriendlyStr(new Date(assignment.due_at.replace(' ','T'))) : t('noDeadline') }}
                    </v-chip>
                  </v-col>
                  <v-col cols="12" class="py-1">
                    <DueIndicator v-if="assignment.due_at && assignment.open_at"
                      :start-time="assignment.open_at.replace(' ','T')"
                      :due-time="assignment.due_at.replace(' ','T')"
                      :disabled="!assignment.accepting"
                    />
                  </v-col>
                </v-row>
                <div
                  :style="{ height: `${assignmentPlaceholders(course) * 42}px` }"
                  aria-hidden="true"
                />
              </div>
            </v-card-text>
            <v-divider />
            <v-card-actions>
              <v-btn
                v-if="isTeacher || isAssistantFor(course)"
                :to="{
                  name: 'course-statistics',
                  params: { courseId: String(course.id) },
                }"
                prepend-icon="mdi-chart-box-outline"
                :text="t('courseStatistics')"
              />
              <v-spacer />
              <v-btn
                :to="{
                  name: 'assignments-list',
                  params: { courseId: String(course.id) },
                }"
                color="primary"
                variant="tonal"
                :text="t('enter')"
                append-icon="mdi-arrow-right"
              />
            </v-card-actions>
          </v-card>
        </template>
      </VirtualCollection>
    </v-skeleton-loader>
    <HojCourseBridge @synced="refreshCourses" />
    <ModifyCourseDialog v-if="isTeacher" v-model="createCourseDialog" operation-type="create" :course="newCourse" @created="refreshCourses" />
  </v-container>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { useAppStore } from "@/stores/app";
import { usePreferenceStore } from "@/stores/theme";
import { ApiGetCoursesListWithRecentAssignments } from "@/api/course";
import { CourseWithAssignments, ProgrammingWork, Course } from "@/api/course";
import { getDueTimeColor } from "@/utils/assignments";
import { getYearTermName, makeYearTermList } from "@/utils/courses";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import VirtualCollection from "@/components/VirtualCollection.vue";
import PageFilter from "@/components/PageFilter.vue";

const RECENT_ASSIGNMENT_SLOTS = 3;

/** 将教师姓名用顿号连接
 */
function getTeachers(course: CourseWithAssignments) {
  return course.teachers.map((teacher) => teacher.real_name).join("、");
}

function dueTimeColor(assignment: ProgrammingWork) {
  return getDueTimeColor(new Date(assignment.due_at!.replace(' ','T')), !assignment.accepting);
}

/** 计算 futureDate 到现在的时间差，并返回一段简明的时间短语。
 */
function dateFriendlyStr(futureDate: Date) {
  const now = new Date().getTime();
  const dt = (futureDate.getTime() - now) / 1000; // (秒)
  const oneHour = 60 * 60; // (秒)
  const oneDay = 24 * oneHour; // (秒)

  if (locale.value === "en") {
    if (dt < 0) {
      return "Closed";
    }
    if (dt < 60) {
      return "Closing soon";
    }
    const m = Math.floor((dt % oneHour) / 60);
    const MM = `${m} minute${m === 1 ? "" : "s"}`;
    if (dt < oneHour) {
      return `Due in ${MM}`;
    }
    const h = Math.floor((dt % oneDay) / oneHour);
    const HH = `${h} hour${h === 1 ? "" : "s"}`;
    if (dt < oneDay) {
      return `Due in ${HH}`;
    }
    if (dt < 120 * oneDay) {
      const d = Math.floor(dt / oneDay);
      const DD = `${d} day${d === 1 ? "" : "s"}`;
      return `Due in ${DD}`;
    }
    return `Due on ${futureDate.toLocaleDateString()}`;
  }

  if (dt < 0) {
    return "已截止";
  }
  if (dt < 60) {
    return "即将截止";
  }
  if (dt < oneHour) {
    return `${Math.floor(dt / 60)} 分钟后截止`;
  }
  if (dt < oneDay) {
    const h = Math.floor(dt / oneHour);
    const m = Math.floor((dt % oneHour) / 60);
    return m === 0 ? `${h} 小时后截止` : `${h} 小时 ${m} 分钟后截止`;
  }
  if (dt < 120 * oneDay) {
    const d = Math.floor(dt / oneDay);
    const h = Math.floor((dt % oneDay) / oneHour);
    return h === 0 || d >= 7 ? `${d} 天后截止` : `${d} 天 ${h} 小时后截止`;
  }
  return `${futureDate.toLocaleDateString()}截止`;
}

const loading = ref(true);
const loadError=ref('');
const filter = ref("");
const { isTeacher, user: me } = storeToRefs(useAppStore());
const { courseView } = storeToRefs(usePreferenceStore());
const { t, locale } = useI18n();
const createCourseDialog = ref(false);
const newCourse = ref({} as Course);
function createCourse() {
  const today = new Date();
  newCourse.value = {
    id: 0, title: '', year: selectedSemester.value?.year ?? today.getFullYear(),
    term: selectedSemester.value?.term ?? (today.getMonth() < 5 ? 0 : today.getMonth() < 7 ? 1 : 2),
    teachers: [me.value], assistants: [], students: [],
  };
  createCourseDialog.value = true;
}

function isAssistantFor(c: CourseWithAssignments) {
  return c.assistants.includes(me.value.id);
}

function assignmentPlaceholders(course: CourseWithAssignments) {
  return Math.max(0, RECENT_ASSIGNMENT_SLOTS - course.programming.recent.length);
}

// This response is replaced as a whole; none of its nested records are edited here.
const yearTermList = shallowRef<
  { year: number; term: number; courses: CourseWithAssignments[] }[]
>([]);
const selectedSemesterKey = ref("");
const tabItems = computed(() =>
  yearTermList.value.map((semester) => ({
    value: `${semester.year}-${semester.term}`,
    text: getYearTermName(semester),
  })),
);
const selectedSemester = computed(() =>
  yearTermList.value.find(
    (semester) => `${semester.year}-${semester.term}` === selectedSemesterKey.value,
  ),
);
const allCourses = computed(() =>
  yearTermList.value.flatMap((semester) => semester.courses),
);
const hasFilter = computed(() => filter.value.trim().length > 0);
const filteredCourses = computed(() => {
  const courses = hasFilter.value
    ? allCourses.value
    : (selectedSemester.value?.courses ?? []);
  const query = filter.value.trim().toLocaleLowerCase();
  return query
    ? courses.filter(
        (course) =>
          course.title.toLocaleLowerCase().includes(query) ||
          course.teachers.some((teacher) =>
            teacher.real_name.toLocaleLowerCase().includes(query),
          ),
      )
    : courses;
});

async function refreshCourses() {
  loading.value=true;loadError.value='';
  try{
    const courses = (await ApiGetCoursesListWithRecentAssignments()).data;
    yearTermList.value = makeYearTermList(courses);
    if (!tabItems.value.some(item => item.value === selectedSemesterKey.value))
      selectedSemesterKey.value = tabItems.value[0]?.value ?? "";
  }catch(e){loadError.value=e instanceof Error?e.message:String(e);yearTermList.value=[];}
  finally{loading.value = false;}
}
onActivated(refreshCourses);
</script>

<style scoped>
.course-list-row {
  display: flex;
  align-items: center;
}

.course-list-link {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: 12px 16px;
  color: inherit;
  text-decoration: none;
}

.course-list-link:hover,
.course-list-link:focus-visible {
  background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity));
}

.course-list-link:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.course-list-content,
.course-list-title {
  flex: 1;
  min-width: 0;
}
</style>

<route lang="yaml">
name: courses-list
meta:
  title: 课程列表
  titleEn: Courses
</route>

<i18n lang="yaml">
zh:
  createCourse: 新建课程
  courses: 课程
  filterCourses: 搜索课程或负责人（全部学期）
  noMatchingCourses: 没有匹配的课程
  allSemesterResults: "搜索全部学期，共 {count} 门课程"
  noCourses: 没有任何课程！😊
  TA: 助教
  teachers: 课程负责人
  recentAssignments: "已发布作业 {count} 次"
  noDeadline: 未设截止
  retry: 重试
  noRecentAssignments: 近期暂无作业
  enter: 进入课程
  courseStatistics: 课程数据统计
en:
  createCourse: New course
  courses: Courses
  filterCourses: Search courses or coordinators (all semesters)
  noMatchingCourses: No matching courses
  allSemesterResults: "All semesters · {count} courses"
  noCourses: "No courses available for the moment! 😊"
  TA: TA
  teachers: Coordinator | Coordinators
  recentAssignments: "Published assignments: {count}"
  noDeadline: No deadline
  retry: Retry
  noRecentAssignments: No recent assignments.
  enter: Go
  courseStatistics: Statistics
</i18n>
